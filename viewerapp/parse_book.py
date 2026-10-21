import json
import re
import os

def parse_markdown():
    source_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '끝까지검수후.md'))
    output_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'src', 'bookData.json'))

    with open(source_path, 'r', encoding='utf-8') as f:
        text = f.read()

    pattern = re.compile(r'<!--\s*Page\s*(\d+)\s*-->', re.IGNORECASE)
    splits = list(pattern.finditer(text))

    pages = []
    # Pre-marker (Page 1)
    p1 = text[:splits[0].start()].strip() if splits else text.strip()
    p1 = re.sub(r'^\s*---\s*', '', p1)
    p1 = re.sub(r'\s*---\s*$', '', p1).strip()
    pages.append({
        'pageIndex': 0,
        'pageNumber': 1,
        'content': p1
    })

    for i, m in enumerate(splits):
        p_num = int(m.group(1))
        start = m.end()
        end = splits[i+1].start() if i+1 < len(splits) else len(text)
        chunk = text[start:end].strip()
        chunk = re.sub(r'^\s*---\s*', '', chunk)
        chunk = re.sub(r'\s*---\s*$', '', chunk).strip()
        pages.append({
            'pageIndex': i + 1,
            'pageNumber': p_num,
            'content': chunk
        })

    toc = []
    toc_id = 0
    for p in pages:
        h1s = re.findall(r'^#\s+(.+)$', p['content'], re.MULTILINE)
        for h in h1s:
            t = h.strip()
            if t:
                toc.append({
                    'id': f'toc-{toc_id}',
                    'title': t,
                    'pageIndex': p['pageIndex'],
                    'pageNumber': p['pageNumber']
                })
                toc_id += 1

    data = {
        'title': '포항공과대학교 총학생회 30년사',
        'totalPages': len(pages),
        'pages': pages,
        'toc': toc
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f'Successfully parsed {len(pages)} pages and {len(toc)} TOC entries to {output_path}')

if __name__ == '__main__':
    parse_markdown()
