"""Add a bookmark outline to the Chrome-rendered guide.

Chrome preserves anchor links but emits no outline, so the bookmark panel is added here.
Sections are located by a phrase unique to the section body: searching for the section
titles matches the contents page instead and pins every bookmark to page 2.
"""
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

PDF = 'docs/FinTrack-Guide.pdf'

# (bookmark label, phrase found only in that section's body, first page index to search)
SECTIONS = [
    ('Contents',                           'How to read this',                    1),
    ('1. Do I still need Docker?',         'only for the three databases',        2),
    ('2. The system in one picture',       'Two process types, not six services', 2),
    ('3. From clone to running',           'Colima is the container runtime',     2),
    ('4. The two ways to run it',          'Never run both at once',              2),
    ('5. Feature walkthrough',             'every block below reuses',            2),
    ('6. The six guarantees',              'not asserted',                        2),
    ('7. Inside the three databases',      'Try to break one by hand',            2),
    ('8. Tests, benchmarks, load results', 'Mocks cannot demonstrate row',        2),
    ('9. Scaling and proving it',          'Prove requests actually distribute',  2),
    ('10. Troubleshooting',                'Start over with clean data',          2),
    ('11. The 90-second demo',             'Then say the thing that actually',    2),
]


def main() -> None:
    reader = PdfReader(PDF)
    pages = [(p.extract_text() or '').replace('\n', ' ') for p in reader.pages]

    writer = PdfWriter(clone_from=PDF)
    root = writer.add_outline_item('FinTrack — Setup & Verification Guide', 0)

    missing = []
    for label, needle, start in SECTIONS:
        page = next((i for i in range(start, len(pages)) if needle in pages[i]), None)
        if page is None:
            missing.append(label)
            continue
        writer.add_outline_item(label, page, parent=root)
        print(f'  p{page + 1:>2}  {label}')

    writer.add_metadata({
        '/Title': 'FinTrack — Setup & Verification Guide',
        '/Subject': 'Running FinTrack locally and verifying every feature and guarantee',
        '/Keywords': 'Node.js, Express, PostgreSQL, MongoDB, Redis, BullMQ, Docker, Nginx',
        '/Creator': 'FinTrack project documentation',
    })
    # Open with the bookmark panel showing, so the navigation is found rather than hunted for.
    writer._root_object[NameObject('/PageMode')] = NameObject('/UseOutlines')

    with open(PDF, 'wb') as handle:
        writer.write(handle)

    if missing:
        raise SystemExit(f'no page found for: {missing}')
    print(f'\n  {len(SECTIONS)} bookmarks written to {PDF}')


if __name__ == '__main__':
    main()
