"""
LLM Formatter module for Book Scanner.
Formats raw OCR Korean text into clean, structured Markdown.
Supports:
1. Ollama local LLM (Qwen2.5, Llama3.2, EXAONE, etc.)
2. Custom OpenAI-compatible endpoints (LM Studio, vLLM)
3. Built-in Smart Rule-based / Regex Formatter as instant offline fallback
"""

import re
import httpx
from typing import Dict, Any, List, Optional, AsyncGenerator

BOOK_FORMAT_PROMPT = """너는 전문 서적 편집자이자 마크다운 서식화 전문가이다.
다음은 책을 스캔하여 OCR로 인식한 한국어 원문 텍스트이다.
줄바꿈이 부자연스럽거나, 제목과 본문이 구분되지 않았거나, 오탈자가 일부 포함되어 있을 수 있다.

아래 규칙을 엄격히 준수하여 읽기 좋은 표준 Markdown(마크다운) 형식으로 재구성하라:

[서식화 규칙]
1. 문맥상 하나의 문장이 인쇄 여백 때문에 줄바꿈된 경우, 문장을 자연스럽게 이어 붙여라.
2. 문단(단락)이 끝나는 지점에는 빈 줄(엔터 2번)을 넣어 단락 구분을 명확히 하라.
3. 장, 절, 소제목으로 판단되는 텍스트는 레벨에 맞게 Markdown 헤딩(`#`, `##`, `###`)으로 변환하라.
4. 페이지 번호(예: - 123 -, 45 등)나 상/하단 머리글(러닝헤더) 같은 책 스캔 노이즈는 본문에서 제거하라.
5. 인용문이나 독백은 인용 블록(`> `)으로 처리하고, 열거형 항목은 목록(`- ` 또는 `1. `)으로 정리하라.
6. OCR 오탈자(조사, 오인식된 기호)는 문맥에 맞게 매끄럽게 교정하되, 원작자의 고유한 어투와 표현은 왜곡하지 말라.
7. 연표, 역사, 연도별 기록(예: 1987, 1988년 등)이 포함된 경우, 연도를 소제목(예: `### 1987년`)으로 구분하고 해당 연도의 사건들을 글머리 기호(`- `)로 일목요연하게 정리하라.
8. 답변에는 서론, 인사말, 코드블록 기호(```markdown 등)를 붙이지 말고 '오직 변환된 마크다운 본문만' 출력하라.

[입력 OCR 텍스트]
{ocr_text}
"""


class LLMFormatter:
    def __init__(self, ollama_url: str = "http://localhost:11434"):
        self.ollama_url = ollama_url.rstrip("/")
        self.default_model = "qwen2.5:3b"

    async def check_ollama_status(self) -> Dict[str, Any]:
        """Checks if local Ollama server is running and returns installed models."""
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                res = await client.get(f"{self.ollama_url}/api/tags")
                if res.status_code == 200:
                    data = res.json()
                    models = [m.get("name") for m in data.get("models", [])]
                    return {
                        "available": True,
                        "models": models,
                        "default_model": self.default_model if self.default_model in models else (models[0] if models else self.default_model),
                        "url": self.ollama_url
                    }
        except Exception:
            pass

        return {
            "available": False,
            "models": [],
            "default_model": self.default_model,
            "url": self.ollama_url
        }

    async def format_with_ollama(
        self,
        ocr_text: str,
        model: Optional[str] = None,
        preset: int = 1,
        temperature: float = 0.2
    ) -> str:
        """Sends OCR text to Ollama for markdown structuring."""
        target_model = model or self.default_model

        preset_guide = ""
        if preset == 1:
            preset_guide = (
                "\n[선택된 프리셋: 1 (연도별 연표)]\n"
                "- 왼쪽의 연도들과 오른쪽 활동 내역들을 매칭하여 연도별로 '### 1987년' 형태의 헤딩을 만들고, "
                "하위 활동들은 '- ' 글머리 기호 목록으로 정돈하라.\n"
            )
        elif preset == 2:
            preset_guide = (
                "\n[선택된 프리셋: 2 (일반 단체 및 항목 목록)]\n"
                "- 맨 위의 연도와 단체명(예: 1987년, 제1대 총학생회)을 합쳐 '# 1987년 제1대 총학생회' 메인 제목으로 작성하라.\n"
                "- 그 아래의 각 볼드 소제목들은 '### 소제목'으로 구분하고, 본문 내용을 매끄러운 단락으로 작성하라.\n"
            )

        prompt = BOOK_FORMAT_PROMPT.format(ocr_text=ocr_text) + preset_guide

        payload = {
            "model": target_model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_ctx": 4096,
            }
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            res = await client.post(f"{self.ollama_url}/api/generate", json=payload)
            res.raise_for_status()
            data = res.json()
            return data.get("response", "").strip()

    async def format_stream_ollama(
        self,
        ocr_text: str,
        model: Optional[str] = None,
        preset: int = 1
    ) -> AsyncGenerator[str, None]:
        """Streams formatted tokens from Ollama."""
        target_model = model or self.default_model

        preset_guide = ""
        if preset == 1:
            preset_guide = "\n[선택된 프리셋: 1 (연도별 연표)] 각 연도는 '### 1987년', 사건들은 '- ' 목록으로 정리하라.\n"
        elif preset == 2:
            preset_guide = "\n[선택된 프리셋: 2 (일반 단체 및 항목 목록)] 상단은 '# {연도} {단체명}', 하위는 '### {소제목}'과 단락으로 정리하라.\n"

        prompt = BOOK_FORMAT_PROMPT.format(ocr_text=ocr_text) + preset_guide

        payload = {
            "model": target_model,
            "prompt": prompt,
            "stream": True,
            "options": {
                "temperature": 0.2,
                "num_ctx": 4096,
            }
        }

        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream("POST", f"{self.ollama_url}/api/generate", json=payload) as response:
                import json
                async for line in response.aiter_lines():
                    if line:
                        try:
                            chunk = json.loads(line)
                            yield chunk.get("response", "")
                        except Exception:
                            continue

    def format_smart_regex(self, ocr_text: str, preset: int = 1) -> str:
        """
        Instant offline fallback formatter when LLM is unavailable:
        - Preset 1: Chronological timeline (### 1987년 + - event bullets)
        - Preset 2: General section (# Top Title + ### Bold Subheadings + Body paragraphs)
        """
        if not ocr_text or not ocr_text.strip():
            return ""

        lines = [line.strip() for line in ocr_text.splitlines() if line.strip()]
        cleaned_lines = []

        # Regex patterns
        page_num_pattern = re.compile(r"^[-—~·*]?\s*\d+\s*[-—~·*]?$")
        chapter_pattern = re.compile(r"^(제\s*\d+\s*[장절편부]|Chapter\s*\d+|CHAPTER\s*\d+|PART\s*\d+)", re.IGNORECASE)
        section_pattern = re.compile(r"^\d+[\.\)]\s+|^[一二三四五六七八九十]+[\.\)]\s+")
        list_pattern = re.compile(r"^[-*•·,]\s*|^['‘’\"“”]\s+|\d+[\.]\s+")

        # Sentence end markers in Korean & English
        sentence_ends = (".", "!", "?", "다.", "요.", "죠.", "까?", "음.", "임.", "\"", "'", "”", "’")

        i = 0
        while i < len(lines):
            line = lines[i]

            # 1. Skip page number lines
            if page_num_pattern.match(line):
                i += 1
                continue

            # 2. Existing markdown headings
            if line.startswith("#"):
                cleaned_lines.append(f"\n{line}\n")
                i += 1
                continue

            # 3. Timeline / Year Heading detection (for Preset 1 or general timeline lines)
            if preset == 1:
                year_match = re.match(r"^(19\d{2}|20\d{2})(?:년)?(?:\s*[-—~·:•*]\s*(.*))?$", line)
                if year_match:
                    year_num = year_match.group(1)
                    trailing_content = year_match.group(2)
                    cleaned_lines.append(f"\n### {year_num}년\n")
                    if trailing_content and trailing_content.strip():
                        cleaned_lines.append(f"- {trailing_content.strip()}")
                    i += 1
                    continue

            # 4. Heading detection: Chapter
            if chapter_pattern.match(line):
                cleaned_lines.append(f"\n## {line}\n")
                i += 1
                continue

            # 5. Heading detection: Section / Numbered title
            if section_pattern.match(line) and len(line) < 40:
                cleaned_lines.append(f"\n### {line}\n")
                i += 1
                continue

            # 6. List items (normalize •, ·, *, ,, quote bullets to -)
            if list_pattern.match(line):
                normalized_list = re.sub(r"^[-*•·,]\s*|^['‘’\"“”]\s+", "- ", line)
                cleaned_lines.append(normalized_list)
                i += 1
                continue

            # 7. Line continuation: check if previous line can be merged
            if cleaned_lines and not cleaned_lines[-1].startswith("#") and not cleaned_lines[-1].startswith("\n#") and not cleaned_lines[-1].startswith("1. "):
                prev = cleaned_lines[-1]
                # If previous was a bullet item that wrapped across lines without a sentence terminator
                if prev.startswith("- ") and not any(prev.rstrip().endswith(end) for end in sentence_ends):
                    cleaned_lines[-1] = f"{prev} {line}"
                    i += 1
                    continue
                # If previous normal text didn't end with sentence terminator, join with space
                elif not prev.startswith("- ") and not any(prev.rstrip().endswith(end) for end in sentence_ends):
                    cleaned_lines[-1] = f"{prev} {line}"
                    i += 1
                    continue

            cleaned_lines.append(line)
            i += 1

        # Join paragraphs
        result = []
        for line in cleaned_lines:
            if line.startswith("\n#") or line.startswith("#"):
                result.append("\n" + line.strip() + "\n")
            elif any(line.rstrip().endswith(end) for end in sentence_ends):
                result.append(line + "\n")
            else:
                result.append(line)

        formatted = "\n".join(result)
        # Normalize multiple blank lines
        formatted = re.sub(r"\n{3,}", "\n\n", formatted).strip()
        return formatted


# Singleton instance
llm_formatter = LLMFormatter()
