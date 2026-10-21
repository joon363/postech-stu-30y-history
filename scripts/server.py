"""
FastAPI Server for Book Scanner Application.
Supports dual HTTP (port 8000) and HTTPS (port 8443) for seamless mobile camera access.
Supports Android USB debugging (adb reverse) for zero-latency localhost mobile connection.
"""

import os
import io
import sys
import re
import time
import json
import socket
import shutil
import zipfile
import asyncio
import datetime
import ipaddress
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Optional

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import qrcode
from PIL import Image, ImageOps
import uvicorn
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ocr_engine import ocr_engine
from pdf_processor import pdf_processor
from llm_formatter import llm_formatter

# Directories
BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"
THUMBNAILS_DIR = UPLOADS_DIR / "thumbs"
OUTPUT_DIR = BASE_DIR / "output"
STATIC_DIR = BASE_DIR / "static"
SESSION_FILE = BASE_DIR / "session.json"
CERT_FILE = BASE_DIR / "cert.pem"
KEY_FILE = BASE_DIR / "key.pem"

for d in [UPLOADS_DIR, THUMBNAILS_DIR, OUTPUT_DIR, STATIC_DIR]:
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="BookScan Studio", version="1.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# WebSocket Connection Manager for Remote PC Shutter Trigger
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                self.disconnect(connection)


ws_manager = ConnectionManager()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, Exception):
        ws_manager.disconnect(websocket)


def get_local_ip() -> str:
    """Find the Wi-Fi/LAN IPv4 address of this machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def ensure_ssl_certs():
    """Generates self-signed SSL certificates if not already existing."""
    if CERT_FILE.exists() and KEY_FILE.exists():
        return str(CERT_FILE), str(KEY_FILE)

    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives import serialization

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, "BookScanStudio"),
        ])

        local_ip = get_local_ip()
        san_entries = [
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        ]
        if local_ip != "127.0.0.1":
            try:
                san_entries.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
            except Exception:
                pass

        san = x509.SubjectAlternativeName(san_entries)

        cert = x509.CertificateBuilder().subject_name(
            subject
        ).issuer_name(
            issuer
        ).public_key(
            key.public_key()
        ).serial_number(
            x509.random_serial_number()
        ).not_valid_before(
            datetime.datetime.now(datetime.timezone.utc)
        ).not_valid_after(
            datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365)
        ).add_extension(
            san, critical=False
        ).sign(key, hashes.SHA256())

        with open(KEY_FILE, "wb") as f:
            f.write(key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption()
            ))

        with open(CERT_FILE, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))

        print(" SSL certificates generated successfully!")
    except Exception as e:
        print(f" Warning: Could not generate SSL certificate: {e}")

    return str(CERT_FILE), str(KEY_FILE)


def try_adb_reverse():
    """Checks for connected Android devices and forwards port 8000 via adb."""
    try:
        proc = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=3)
        lines = [line.strip() for line in proc.stdout.splitlines() if line.strip() and not line.startswith("*")]
        if len(lines) > 1:
            devices = [l.split()[0] for l in lines[1:] if "\tdevice" in l]
            if devices:
                subprocess.run(["adb", "reverse", "tcp:8000", "tcp:8000"], capture_output=True, text=True, timeout=3)
                return {
                    "connected": True,
                    "devices": devices,
                    "message": f"USB 기기 감지됨 ({', '.join(devices)}). http://localhost:8000/mobile 바로 접속 가능"
                }
    except Exception as e:
        return {"connected": False, "devices": [], "message": f"ADB 확인 실패: {e}"}

    return {"connected": False, "devices": [], "message": "연결된 USB 디버깅 기기 없음"}


# Session State Management
class SessionManager:
    def __init__(self, filepath: Path):
        self.filepath = filepath
        self.lock = asyncio.Lock()
        self.data: Dict[str, Any] = self._load()

    def _load(self) -> Dict[str, Any]:
        if self.filepath.exists():
            try:
                with open(self.filepath, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "book_title": "나의_스캔_도서",
            "pages": [],
            "next_page_num": 1,
            "selected_model": "qwen2.5:3b"
        }

    async def save(self):
        async with self.lock:
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)

    def get_pages(self) -> List[Dict[str, Any]]:
        return sorted(self.data.get("pages", []), key=lambda p: p.get("page_number", 0))

    def get_page(self, page_id: str) -> Optional[Dict[str, Any]]:
        for page in self.data.get("pages", []):
            if page["id"] == page_id:
                return page
        return None

    def add_page(self, page_dict: Dict[str, Any]):
        self.data["pages"].append(page_dict)
        if page_dict["page_number"] >= self.data.get("next_page_num", 1):
            self.data["next_page_num"] = page_dict["page_number"] + 1

    def remove_page(self, page_id: str) -> bool:
        initial_len = len(self.data["pages"])
        self.data["pages"] = [p for p in self.data["pages"] if p["id"] != page_id]
        return len(self.data["pages"]) < initial_len

    def clear(self):
        self.data["pages"] = []
        self.data["next_page_num"] = 1


session = SessionManager(SESSION_FILE)


def generate_thumbnail(image_path: Path, thumb_path: Path, max_size=(300, 400)):
    try:
        with Image.open(image_path) as img:
            img = ImageOps.exif_transpose(img)
            img.thumbnail(max_size, Image.Resampling.LANCZOS)
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.save(thumb_path, "JPEG", quality=80)
    except Exception as e:
        print(f"Error generating thumbnail: {e}")


# API Endpoints
@app.get("/api/info")
async def get_info():
    local_ip = get_local_ip()
    port_http = 8000
    port_https = 8443

    mobile_https_url = f"https://{local_ip}:{port_https}/mobile"
    mobile_http_url = f"http://{local_ip}:{port_http}/mobile"
    mobile_usb_url = f"http://localhost:{port_http}/mobile"

    ollama_info = await llm_formatter.check_ollama_status()
    adb_info = try_adb_reverse()
    pages = session.get_pages()

    return {
        "local_ip": local_ip,
        "port_http": port_http,
        "port_https": port_https,
        "mobile_https_url": mobile_https_url,
        "mobile_http_url": mobile_http_url,
        "mobile_usb_url": mobile_usb_url,
        "adb": adb_info,
        "ollama": ollama_info,
        "book_title": session.data.get("book_title", "나의_스캔_도서"),
        "current_preset": session.data.get("current_preset", 1),
        "total_pages": len(pages),
        "next_page_num": session.data.get("next_page_num", len(pages) + 1),
        "ocr_done_count": sum(1 for p in pages if p.get("ocr_text")),
        "formatted_count": sum(1 for p in pages if p.get("formatted_text")),
    }


@app.get("/api/adb/reverse")
async def api_adb_reverse():
    return try_adb_reverse()


@app.post("/api/preset")
async def set_preset(preset: int = Query(...)):
    """Sets current active preset (1: 연표 타임라인, 2: 일반 단체/소제목 목록)"""
    if preset not in [1, 2]:
        raise HTTPException(status_code=400, detail="Invalid preset (must be 1 or 2)")
    session.data["current_preset"] = preset
    await session.save()
    return {"success": True, "preset": preset}


@app.post("/api/remote-snap")
async def api_remote_snap(preset: Optional[int] = Query(None)):
    """Triggers remote snapshot on all connected mobile phones over WebSocket."""
    if preset in [1, 2]:
        session.data["current_preset"] = preset
        await session.save()

    cur_preset = session.data.get("current_preset", 1)
    active_count = len(ws_manager.active_connections)
    await ws_manager.broadcast({
        "action": "snap",
        "preset": cur_preset,
        "timestamp": time.time()
    })
    return {
        "success": True,
        "preset": cur_preset,
        "phones_triggered": active_count,
        "message": f"{active_count}대 스마트폰에 원격 촬영 신호 전송됨 (프리셋 {cur_preset})" if active_count > 0 else "연결된 스마트폰이 없습니다 (폰에서 스캐너 화면을 열어주세요)"
    }


@app.get("/api/qr")
async def get_qr_code(mode: str = Query("https")):
    """Generates QR code for mobile access (defaults to HTTPS for full camera permissions)."""
    local_ip = get_local_ip()
    if mode == "http":
        target_url = f"http://{local_ip}:8000/mobile"
    elif mode == "usb":
        target_url = "http://localhost:8000/mobile"
    else:
        target_url = f"https://{local_ip}:8443/mobile"

    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(target_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f172a", back_color="#ffffff")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="image/png")


@app.get("/api/pages")
async def get_pages():
    return session.get_pages()


class BookTitleUpdate(BaseModel):
    title: str


@app.post("/api/title")
async def update_title(body: BookTitleUpdate):
    session.data["book_title"] = body.title.strip() or "나의_스캔_도서"
    await session.save()
    return {"success": True, "title": session.data["book_title"]}


@app.post("/api/upload")
async def upload_image(
    files: List[UploadFile] = File(...),
    page_number: Optional[int] = Form(None),
    preset: Optional[int] = Form(None),
    auto_ocr: bool = Form(True),
    background_tasks: BackgroundTasks = None
):
    uploaded_pages = []
    current_next_num = session.data.get("next_page_num", len(session.data.get("pages", [])) + 1)
    page_preset = preset if preset in [1, 2] else session.data.get("current_preset", 1)

    for i, file in enumerate(files):
        p_num = page_number if (page_number is not None and len(files) == 1) else (current_next_num + i)
        page_id = f"page_{int(time.time() * 1000)}_{p_num}_{i}"
        ext = Path(file.filename or "image.jpg").suffix.lower()
        if ext not in [".jpg", ".jpeg", ".png", ".webp"]:
            ext = ".jpg"

        dest_filename = f"{page_id}{ext}"
        dest_path = UPLOADS_DIR / dest_filename
        thumb_filename = f"thumb_{page_id}.jpg"
        thumb_path = THUMBNAILS_DIR / thumb_filename

        content = await file.read()
        with open(dest_path, "wb") as f:
            f.write(content)

        generate_thumbnail(dest_path, thumb_path)

        page_record = {
            "id": page_id,
            "page_number": p_num,
            "filename": dest_filename,
            "image_url": f"/uploads/{dest_filename}",
            "thumb_url": f"/uploads/thumbs/{thumb_filename}",
            "preset": page_preset,
            "ocr_text": "",
            "formatted_text": "",
            "status": "pending",
            "created_at": time.time(),
        }

        session.add_page(page_record)
        uploaded_pages.append(page_record)

    await session.save()

    if auto_ocr and uploaded_pages:
        for page in uploaded_pages:
            if background_tasks:
                background_tasks.add_task(run_page_ocr_background, page["id"])

    return {
        "success": True,
        "count": len(uploaded_pages),
        "pages": uploaded_pages,
        "next_page_num": session.data.get("next_page_num")
    }


async def run_page_ocr_background(page_id: str):
    page = session.get_page(page_id)
    if not page:
        return
    page["status"] = "ocr_running"
    await session.save()

    page_preset = page.get("preset", session.data.get("current_preset", 1))
    image_path = UPLOADS_DIR / page["filename"]
    res = await ocr_engine.recognize_file(image_path, preset=page_preset)

    if res.get("success"):
        page["ocr_text"] = res.get("text", "")
        page["formatted_text"] = llm_formatter.format_smart_regex(page["ocr_text"], preset=page_preset)
        page["status"] = "ocr_done"
    else:
        page["status"] = "error"
        page["error_msg"] = res.get("error", "OCR failed")

    await session.save()


@app.post("/api/upload-pdf")
async def upload_pdf(
    file: UploadFile = File(...),
    auto_ocr: bool = Form(False),
    background_tasks: BackgroundTasks = None
):
    temp_pdf = UPLOADS_DIR / f"temp_{int(time.time())}_{file.filename}"
    content = await file.read()
    with open(temp_pdf, "wb") as f:
        f.write(content)

    try:
        extracted = pdf_processor.process_pdf(temp_pdf, prefix=f"pdf_{int(time.time())}")
    finally:
        if temp_pdf.exists():
            temp_pdf.unlink()

    current_next_num = session.data.get("next_page_num", 1)
    added_pages = []

    for item in extracted:
        p_num = current_next_num
        current_next_num += 1
        page_id = f"page_pdf_{int(time.time() * 1000)}_{p_num}"
        img_name = item["image_filename"]
        img_path = Path(item["image_path"])

        thumb_name = f"thumb_{img_name}"
        thumb_path = THUMBNAILS_DIR / thumb_name
        generate_thumbnail(img_path, thumb_path)

        initial_text = item.get("embedded_text", "")
        status = "ocr_done" if initial_text else "pending"

        page_record = {
            "id": page_id,
            "page_number": p_num,
            "filename": img_name,
            "image_url": f"/uploads/{img_name}",
            "thumb_url": f"/uploads/thumbs/{thumb_name}",
            "ocr_text": initial_text,
            "formatted_text": "",
            "status": status,
            "created_at": time.time(),
        }

        session.add_page(page_record)
        added_pages.append(page_record)

    await session.save()

    if auto_ocr and background_tasks:
        for p in added_pages:
            if not p["ocr_text"]:
                background_tasks.add_task(run_page_ocr_background, p["id"])

    return {"success": True, "count": len(added_pages), "pages": added_pages}


@app.post("/api/ocr/{page_id}")
async def trigger_ocr_single(page_id: str, preset: Optional[int] = Query(None)):
    page = session.get_page(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    if preset in [1, 2]:
        page["preset"] = preset

    page_preset = page.get("preset", session.data.get("current_preset", 1))
    image_path = UPLOADS_DIR / page["filename"]
    res = await ocr_engine.recognize_file(image_path, preset=page_preset)

    if res.get("success"):
        page["ocr_text"] = res.get("text", "")
        page["formatted_text"] = llm_formatter.format_smart_regex(page["ocr_text"], preset=page_preset)
        page["status"] = "ocr_done"
        await session.save()
        return {"success": True, "page": page}
    else:
        page["status"] = "error"
        page["error_msg"] = res.get("error", "OCR failed")
        await session.save()
        raise HTTPException(status_code=500, detail=res.get("error"))


@app.post("/api/ocr-all")
async def trigger_ocr_all():
    pages = session.get_pages()
    updated = []
    for page in pages:
        image_path = UPLOADS_DIR / page["filename"]
        page_preset = page.get("preset", session.data.get("current_preset", 1))
        res = await ocr_engine.recognize_file(image_path, preset=page_preset)
        if res.get("success"):
            page["ocr_text"] = res.get("text", "")
            page["formatted_text"] = llm_formatter.format_smart_regex(page["ocr_text"], preset=page_preset)
            page["status"] = "ocr_done"
            updated.append(page["id"])

    await session.save()
    return {"success": True, "updated_count": len(updated)}


class FormatRequest(BaseModel):
    model: Optional[str] = None
    preset: Optional[int] = None
    force_regex: bool = False


@app.post("/api/format/{page_id}")
async def format_page(page_id: str, body: FormatRequest = FormatRequest()):
    page = session.get_page(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    raw_text = page.get("ocr_text", "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="Page has no OCR text to format")

    page_preset = body.preset if body.preset in [1, 2] else page.get("preset", session.data.get("current_preset", 1))
    page["preset"] = page_preset
    page["status"] = "formatting"
    await session.save()

    formatted_result = ""
    engine_used = "smart_regex"

    ollama_info = await llm_formatter.check_ollama_status()

    if ollama_info["available"] and not body.force_regex:
        model_name = body.model or ollama_info.get("default_model") or "qwen2.5:3b"
        try:
            formatted_result = await llm_formatter.format_with_ollama(raw_text, model=model_name, preset=page_preset)
            engine_used = f"ollama ({model_name})"
        except Exception as e:
            formatted_result = llm_formatter.format_smart_regex(raw_text, preset=page_preset)
            engine_used = "smart_regex (fallback)"
    else:
        formatted_result = llm_formatter.format_smart_regex(raw_text, preset=page_preset)
        engine_used = "smart_regex"

    page["formatted_text"] = formatted_result
    page["status"] = "done"
    await session.save()

    return {
        "success": True,
        "page": page,
        "preset": page_preset,
        "engine_used": engine_used,
        "formatted_text": formatted_result
    }


@app.post("/api/format-all")
async def format_all_pages(body: FormatRequest = FormatRequest()):
    pages = session.get_pages()
    formatted_count = 0
    ollama_info = await llm_formatter.check_ollama_status()
    use_ollama = ollama_info["available"] and not body.force_regex
    model_name = body.model or ollama_info.get("default_model") or "qwen2.5:3b"

    for page in pages:
        raw_text = page.get("ocr_text", "").strip()
        if not raw_text:
            continue

        page_preset = body.preset if body.preset in [1, 2] else page.get("preset", session.data.get("current_preset", 1))
        page["preset"] = page_preset

        if use_ollama:
            try:
                page["formatted_text"] = await llm_formatter.format_with_ollama(raw_text, model=model_name, preset=page_preset)
            except Exception:
                page["formatted_text"] = llm_formatter.format_smart_regex(raw_text, preset=page_preset)
        else:
            page["formatted_text"] = llm_formatter.format_smart_regex(raw_text, preset=page_preset)

        page["status"] = "done"
        formatted_count += 1

    await session.save()
    return {"success": True, "count": formatted_count}


class PageUpdate(BaseModel):
    page_number: Optional[int] = None
    preset: Optional[int] = None
    ocr_text: Optional[str] = None
    formatted_text: Optional[str] = None


@app.put("/api/pages/{page_id}")
async def update_page_content(page_id: str, body: PageUpdate):
    page = session.get_page(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    if body.page_number is not None:
        page["page_number"] = body.page_number
    if body.ocr_text is not None:
        page["ocr_text"] = body.ocr_text
    if body.formatted_text is not None:
        page["formatted_text"] = body.formatted_text
        page["status"] = "done"

    await session.save()
    return {"success": True, "page": page}


@app.delete("/api/pages/{page_id}")
async def delete_page(page_id: str):
    page = session.get_page(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    img_path = UPLOADS_DIR / page["filename"]
    thumb_path = THUMBNAILS_DIR / f"thumb_{page['id']}.jpg"
    if img_path.exists():
        try:
            img_path.unlink()
        except Exception:
            pass
    if thumb_path.exists():
        try:
            thumb_path.unlink()
        except Exception:
            pass

    session.remove_page(page_id)
    await session.save()
    return {"success": True}


@app.post("/api/clear")
async def clear_all():
    session.clear()
    await session.save()
    for item in UPLOADS_DIR.glob("*"):
        if item.is_file():
            try:
                item.unlink()
            except Exception:
                pass
    for item in THUMBNAILS_DIR.glob("*"):
        if item.is_file():
            try:
                item.unlink()
            except Exception:
                pass
    return {"success": True}


@app.post("/api/save-book")
async def save_book():
    pages = session.get_pages()
    if not pages:
        raise HTTPException(status_code=400, detail="No pages to save")

    book_title = session.data.get("book_title", "스캔_도서").strip()
    safe_title = "".join(c for c in book_title if c.isalnum() or c in ("-", "_", " ", "가-힣")).rstrip() or "스캔_도서"

    md_filename = f"{safe_title}.md"
    md_filepath = OUTPUT_DIR / md_filename

    lines = [f"# {book_title}\n"]
    lines.append(f"> 스캔 일시: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 총 페이지 수: {len(pages)} 페이지\n\n---\n")

    for page in pages:
        p_num = page.get("page_number", 0)
        content = page.get("formatted_text") or page.get("ocr_text") or "*(내용 없음)*"
        lines.append(f"\n<!-- Page {p_num} -->\n")
        lines.append(content)
        lines.append("\n\n---\n")

    full_markdown = "\n".join(lines)

    with open(md_filepath, "w", encoding="utf-8") as f:
        f.write(full_markdown)

    return {
        "success": True,
        "filename": md_filename,
        "download_url": f"/api/download-book/{md_filename}",
        "filepath": str(md_filepath),
        "total_pages": len(pages),
        "char_count": len(full_markdown)
    }


@app.get("/api/download-book/{filename}")
async def download_book(filename: str):
    filepath = OUTPUT_DIR / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(filepath, filename=filename, media_type="text/markdown; charset=utf-8")


@app.post("/api/import-markdown")
async def import_markdown(
    file: Optional[UploadFile] = File(None),
    filename: Optional[str] = Query(None)
):
    """
    Parses a combined Markdown file with '<!-- Page X -->' separators
    and updates formatted_text for each matching page in session.
    Accepts direct file upload OR loads from output/ or workspace root.
    """
    content = ""
    source_name = ""

    if file:
        raw_bytes = await file.read()
        content = raw_bytes.decode("utf-8", errors="replace")
        source_name = file.filename or "uploaded.md"
    elif filename:
        target_path = OUTPUT_DIR / filename
        if not target_path.exists():
            target_path = BASE_DIR / filename
        if not target_path.exists():
            raise HTTPException(status_code=404, detail=f"File not found: {filename}")
        content = target_path.read_text(encoding="utf-8", errors="replace")
        source_name = str(target_path.name)
    else:
        # Check output directory for .md files or root for all.md
        md_files = list(OUTPUT_DIR.glob("*.md"))
        if md_files:
            latest_md = max(md_files, key=lambda p: p.stat().st_mtime)
            content = latest_md.read_text(encoding="utf-8", errors="replace")
            source_name = f"output/{latest_md.name}"
        elif (BASE_DIR / "all.md").exists():
            content = (BASE_DIR / "all.md").read_text(encoding="utf-8", errors="replace")
            source_name = "all.md"
        else:
            raise HTTPException(status_code=400, detail="불러올 마크다운 파일을 찾을 수 없습니다. (output/ 폴더 또는 파일 업로드 필요)")

    pattern = re.compile(r"<!--\s*Page\s*(\d+)\s*-->\s*(.*?)(?=(?:<!--\s*Page\s*\d+\s*-->)|\Z)", re.DOTALL)
    matches = pattern.findall(content)

    if not matches:
        raise HTTPException(status_code=400, detail="마크다운 파일에서 '<!-- Page 번호 -->' 페이지 구분자를 찾을 수 없습니다.")

    pages_by_num = {p.get("page_number"): p for p in session.data.get("pages", [])}
    updated_pages = []

    for p_num_str, page_content in matches:
        try:
            p_num = int(p_num_str)
        except ValueError:
            continue

        clean_text = page_content.strip()
        clean_text = re.sub(r"\n*---\s*$", "", clean_text).strip()

        if p_num in pages_by_num:
            target_page = pages_by_num[p_num]
            target_page["formatted_text"] = clean_text
            target_page["status"] = "done"
            updated_pages.append(p_num)

    await session.save()

    return {
        "success": True,
        "source": source_name,
        "total_parsed_in_file": len(matches),
        "updated_pages_count": len(updated_pages),
        "updated_pages": updated_pages[:20],
        "message": f"'{source_name}' 파일에서 총 {len(updated_pages)}개 페이지의 본문이 마크다운 편집기에 성공적으로 업데이트되었습니다!"
    }


@app.get("/api/download-zip")
async def download_zip():
    pages = session.get_pages()
    zip_buffer = io.BytesIO()

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for page in pages:
            p_num = page.get("page_number", 0)
            content = page.get("formatted_text") or page.get("ocr_text") or ""
            zip_file.writestr(f"markdown/page_{p_num:04d}.md", content)

            img_path = UPLOADS_DIR / page["filename"]
            if img_path.exists():
                zip_file.write(img_path, arcname=f"images/page_{p_num:04d}_{page['filename']}")

    zip_buffer.seek(0)
    book_title = session.data.get("book_title", "스캔_도서")
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={book_title}.zip"}
    )


# Static and HTML Routes
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return "<h1>BookScan Studio Desktop</h1>"


@app.get("/mobile", response_class=HTMLResponse)
async def serve_mobile():
    mobile_file = STATIC_DIR / "mobile.html"
    if mobile_file.exists():
        return FileResponse(mobile_file)
    return "<h1>BookScan Mobile Shutter</h1>"


async def main():
    cert_path, key_path = ensure_ssl_certs()
    local_ip = get_local_ip()

    config_http = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    config_https = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=8443,
        ssl_keyfile=key_path,
        ssl_certfile=cert_path,
        log_level="info"
    )

    server_http = uvicorn.Server(config_http)
    server_https = uvicorn.Server(config_https)

    print("=" * 65)
    print(" 📖 BookScan Studio Server Started!")
    print(" [💻 노트북 화면]")
    print(f"    http://localhost:8000")
    print(" [📱 스마트폰 카메라 연결]")
    print(f"    1. 🔌 USB 케이블 (추천 - adb):   http://localhost:8000/mobile")
    print(f"    2. 📶 Wi-Fi 무선 HTTPS:          https://{local_ip}:8443/mobile")
    print("=" * 65)

    # Check for connected ADB device and forward port 8000
    try_adb_reverse()

    t1 = asyncio.create_task(server_http.serve())
    t2 = asyncio.create_task(server_https.serve())
    await asyncio.gather(t1, t2)


if __name__ == "__main__":
    asyncio.run(main())
