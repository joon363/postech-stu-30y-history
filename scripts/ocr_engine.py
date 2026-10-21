"""
OCR Engine module for Book Scanner.
Uses Windows Media OCR (winocr) with intelligent 2D spatial layout analysis.
Reconstructs multi-column text, timeline chronology charts, and side-by-side headings
into natural human reading order.
"""

import re
import asyncio
from pathlib import Path
from typing import Dict, Any, List, Optional
from PIL import Image, ImageOps, ImageEnhance
import winocr


class OCREngine:
    def __init__(self, lang: str = "ko"):
        self.lang = lang

    def preprocess_image(self, img: Image.Image) -> Image.Image:
        """
        Preprocesses smartphone book photos:
        1. Corrects EXIF rotation (critical for mobile camera photos)
        2. Converts RGBA to RGB
        3. Normalizes resolution to optimal Windows Media OCR range (~2600px max)
        """
        img = ImageOps.exif_transpose(img)

        if img.mode != "RGB":
            img = img.convert("RGB")

        # Windows Media OCR performs best around 2200-2600px
        # Huge images (>3000px) can trigger internal downscaling that loses fine text
        max_dim = 2600
        if max(img.size) > max_dim:
            scale = max_dim / max(img.size)
            new_size = (int(img.width * scale), int(img.height * scale))
            img = img.resize(new_size, Image.Resampling.LANCZOS)

        return img

    def reconstruct_preset1_timeline(self, line_items: List[Dict[str, Any]], img_width: int) -> List[str]:
        """Preset 1: Chronological Timeline (Left years, Right event bullets - e.g. Page 4)"""
        years = []
        content_items = []
        year_threshold_x = max(600, img_width * 0.38)

        for it in line_items:
            m = re.search(r"\b(19\d{2}|20\d{2})\b", it["text"])
            if m and it["x"] < year_threshold_x:
                year_val = m.group(1)
                years.append({
                    "year": year_val,
                    "y": it["y"],
                    "center_y": it["center_y"],
                    "item": it
                })
                # Check if the line also has trailing text after the year
                rest = it["text"][:m.start()].strip() + " " + it["text"][m.end():].strip()
                rest = re.sub(r"^[—–\-·•/:|,\s]+", "", rest).strip()
                if rest and len(rest) > 2:
                    content_items.append({
                        "text": "• " + rest,
                        "x": it["x"] + it["w"] * 0.4,
                        "y": it["y"],
                        "w": it["w"] * 0.6,
                        "h": it["h"],
                        "center_y": it["center_y"]
                    })
            else:
                content_items.append(it)

        if len(years) < 2:
            return self.reconstruct_row_clustering(line_items)

        years.sort(key=lambda y: y["y"])

        # Filter left margin noise
        filtered_content = []
        for it in content_items:
            if it["x"] < (img_width * 0.12) and len(it["text"]) <= 2:
                continue
            filtered_content.append(it)

        first_year_y = years[0]["y"]
        headers = []
        timeline_items = []

        for it in filtered_content:
            if it["y"] < (first_year_y - 90):
                cleaned = re.sub(r"^[—–\-·•]+\s*", "", it["text"])
                cleaned = re.sub(r"\s*[—–\-·•]+$", "", cleaned).strip()
                if cleaned:
                    headers.append(cleaned)
            else:
                timeline_items.append(it)

        timeline_items.sort(key=lambda it: it["center_y"])

        timeline_blocks = {y["year"]: [] for y in years}
        for it in timeline_items:
            assigned_year = years[-1]["year"]
            for i in range(len(years) - 1):
                next_year_start = years[i + 1]["y"] - 45
                if it["center_y"] < next_year_start:
                    assigned_year = years[i]["year"]
                    break
            timeline_blocks[assigned_year].append(it["text"])

        output_lines = []
        for h in headers:
            output_lines.append(f"# {h}\n")

        for y in years:
            year_str = y["year"]
            output_lines.append(f"{year_str}년")
            for content in timeline_blocks[year_str]:
                output_lines.append(content)

        return output_lines

    def reconstruct_preset2_general(self, line_items: List[Dict[str, Any]], img_width: int, img_height: int) -> List[str]:
        """Preset 2: General Section Page (Top Year/Group Title + {Bold Heading, Body Paragraph} List - e.g. Page 5)"""
        sorted_lines = sorted(line_items, key=lambda l: l['y'])

        # Detect vertical year digits at the top left to accurately bound the top header area
        v_digits = [
            l for l in sorted_lines
            if re.match(r"^\d$", l["text"].strip())
            and l["x"] < (img_width * 0.25)
            and l["y"] < (img_height * 0.22)
        ]
        if len(v_digits) == 4:
            top_cutoff = max(d["y"] for d in v_digits) + 50
        else:
            top_cutoff = img_height * 0.13

        top_items = [l for l in sorted_lines if l["y"] < top_cutoff]
        body_items = [l for l in sorted_lines if l["y"] >= top_cutoff]

        # Filter bottom page numbers and left margin noise
        bottom_cutoff = img_height * 0.85
        filtered_body = []
        for l in body_items:
            txt = l["text"].strip()
            if l["y"] > bottom_cutoff and re.match(r"^\s*[-—~·*]?\s*\d+\s*[-—~·*]?\s*$", txt):
                continue
            if l["x"] < (img_width * 0.08) and len(txt) <= 2:
                continue
            filtered_body.append(l)

        # 1. Process Top Header (Vertical Year Digits + Group Name)
        vertical_digits = []
        other_top = []
        for l in top_items:
            txt = l['text'].strip()
            if re.match(r'^\d$', txt) and l['x'] < (img_width * 0.25):
                vertical_digits.append(l)
            else:
                other_top.append(l)

        vertical_digits.sort(key=lambda l: l['y'])
        year_str = ""
        if len(vertical_digits) == 4:
            cand = "".join(d['text'] for d in vertical_digits)
            if re.match(r'^(19\d{2}|20\d{2})$', cand):
                year_str = f"{cand}년"

        group_parts = []
        for l in other_top:
            t = l['text'].strip()
            m_yr = re.search(r'\b(19\d{2}|20\d{2})년?\b', t)
            if m_yr and not year_str:
                year_str = f"{m_yr.group(1)}년"
                t = t.replace(m_yr.group(0), "").strip()
            if t and len(t) > 1:
                group_parts.append(t)

        group_str = " ".join(group_parts).strip()
        header = ""
        if year_str and group_str:
            header = f"# {year_str} {group_str}"
        elif year_str:
            header = f"# {year_str}"
        elif group_str:
            header = f"# {group_str}"

        # 2. Process Sections: { Bold Title, Content Paragraph }
        sections = []
        current_sec = None

        title_x_threshold = max(420, img_width * 0.22)
        verb_pattern = re.compile(r'(?:었|았|했|있|없|였|됐|된)?(?:다|요|죠|며|고|함|임|음)[,\.]*$')

        for item in filtered_body:
            txt = item['text'].strip()
            if not txt:
                continue

            # Heading candidate: left-aligned, concise, no verb ending, no trailing punctuation
            is_title = (
                item['x'] < title_x_threshold and
                len(txt) < 25 and
                not bool(verb_pattern.search(txt)) and
                not txt.endswith((',', '.', '!', '?', "'", '"', '`')) and
                not re.match(r'^\d+월', txt) and
                not txt.startswith(('•', '-', '·', '*'))
            )

            if is_title:
                if current_sec:
                    sections.append(current_sec)
                current_sec = {
                    'title': txt,
                    'lines': []
                }
            else:
                if current_sec is None:
                    current_sec = {'title': '', 'lines': []}
                current_sec['lines'].append(item)

        if current_sec:
            sections.append(current_sec)

        output = []
        if header:
            output.append(header)
            output.append("")

        for sec in sections:
            if sec['title']:
                output.append(f"### {sec['title']}")

            body_lines = sec['lines']
            if not body_lines:
                continue

            body_lines.sort(key=lambda l: l['y'])
            merged_chunks = []
            for l in body_lines:
                t = l['text'].strip()
                t = re.sub(r"^[-*•·]\s*", "", t)
                merged_chunks.append(t)

            joined_body = " ".join(merged_chunks)
            joined_body = re.sub(r'\s+', ' ', joined_body).strip()
            output.append(joined_body)
            output.append("")

        return output

    def reconstruct_row_clustering(self, line_items: List[Dict[str, Any]]) -> List[str]:
        """General 2D Row Clustering for tables and normal text pages"""
        heights = sorted(it["h"] for it in line_items)
        median_h = heights[len(heights) // 2]
        threshold_y = max(18.0, median_h * 0.55)

        sorted_items = sorted(line_items, key=lambda it: it["center_y"])
        clustered_rows = []

        for it in sorted_items:
            matched = None
            for row in clustered_rows:
                if abs(it["center_y"] - row["avg_y"]) < threshold_y:
                    matched = row
                    break
            if matched:
                matched["items"].append(it)
                matched["avg_y"] = sum(x["center_y"] for x in matched["items"]) / len(matched["items"])
            else:
                clustered_rows.append({"avg_y": it["center_y"], "items": [it]})

        clustered_rows.sort(key=lambda r: r["avg_y"])

        reconstructed = []
        for r in clustered_rows:
            r["items"].sort(key=lambda it: it["x"])
            if len(r["items"]) == 1:
                reconstructed.append(r["items"][0]["text"])
            else:
                first_txt = r["items"][0]["text"].strip()
                cleaned_first = re.sub(r"^[/|\\*·-]+\s*(\d{4})", r"\1", first_txt).strip()
                rest_txt = " ".join(it["text"].strip() for it in r["items"][1:])
                reconstructed.append(f"{cleaned_first} {rest_txt}")

        return reconstructed

    def reconstruct_spatial_lines(self, result_lines, img_width: int = 3000, img_height: int = 4000, preset: int = 1) -> List[str]:
        """
        Reconstructs text lines using 2D spatial bounding box analysis according to selected preset:
        - Preset 1: Chronological Timeline (Year on left, events on right - e.g. Page 4)
        - Preset 2: General Section List (Top year/group, bold heading + content paragraph - e.g. Page 5)
        """
        line_items = []
        for line in result_lines:
            if not line.words:
                continue
            min_x = min(w.bounding_rect.x for w in line.words)
            min_y = min(w.bounding_rect.y for w in line.words)
            max_x = max(w.bounding_rect.x + w.bounding_rect.width for w in line.words)
            max_y = max(w.bounding_rect.y + w.bounding_rect.height for w in line.words)
            line_items.append({
                "text": line.text.strip(),
                "x": min_x,
                "y": min_y,
                "w": max_x - min_x,
                "h": max_y - min_y,
                "center_y": (min_y + max_y) / 2,
            })

        if not line_items:
            return []

        if preset == 2:
            return self.reconstruct_preset2_general(line_items, img_width=img_width, img_height=img_height)
        else:
            return self.reconstruct_preset1_timeline(line_items, img_width=img_width)

    async def recognize_file(self, image_path: Path | str, preset: int = 1) -> Dict[str, Any]:
        """Runs OCR on an image file on disk with 2D spatial layout analysis."""
        path = Path(image_path)
        if not path.exists():
            return {
                "success": False,
                "error": f"Image file not found: {path}",
                "text": "",
                "lines": [],
            }

        try:
            with Image.open(path) as raw_img:
                img = self.preprocess_image(raw_img)
                return await self.recognize_image(img, preset=preset)
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "text": "",
                "lines": [],
            }

    async def recognize_image(self, img: Image.Image, preset: int = 1) -> Dict[str, Any]:
        """Runs OCR on a PIL Image object with 2D spatial layout analysis."""
        try:
            img = self.preprocess_image(img)
            result = await winocr.recognize_pil(img, lang=self.lang)

            # Reconstruct reading order using 2D geometry according to selected preset
            reconstructed_lines = self.reconstruct_spatial_lines(
                result.lines,
                img_width=img.width,
                img_height=img.height,
                preset=preset
            )
            full_text = "\n".join(reconstructed_lines)

            lines_data = [{"text": l} for l in reconstructed_lines]

            return {
                "success": True,
                "text": full_text,
                "lines": lines_data,
                "line_count": len(reconstructed_lines),
                "char_count": len(full_text),
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "text": "",
                "lines": [],
                "line_count": 0,
                "char_count": 0,
            }


# Singleton instance
ocr_engine = OCREngine()
