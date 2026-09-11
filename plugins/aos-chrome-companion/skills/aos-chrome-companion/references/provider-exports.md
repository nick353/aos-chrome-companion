# Provider exports

Use the provider's existing export implementation. Page text extraction does
not prove a native document export, and a healthy connector is not an export
receipt. Preserve the exact source URL, requested format, resulting file
reference, MIME type, size, and any file readback.

## Google Workspace

Use the installed Google Drive skill and read the source metadata first.
The connected `google_drive_export_file` tool takes `id` or `url` and
`mime_type`. Its completed result contains the actual `file_uri`, `size`,
`mimeType`, and `nativeMimeType`.

| Native source | Requested output | Export MIME type |
| --- | --- | --- |
| Docs, Sheets, Slides | PDF | `application/pdf` |
| Docs | Markdown | `text/markdown` |
| Docs | Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Sheets | Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Sheets | CSV | `text/csv` |
| Slides | PowerPoint | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |

Only request a format supported by the source type. Drive's `files.export`
limit is 10 MB. A larger supported native export uses the currently available
streaming `google_drive_fetch` with the same verified source URL,
`download_raw_file:true`, and `raw_export_mime_type`. Stored binary files use
raw fetch. Use the returned authenticated file reference or materialized path;
do not return inline base64 or fabricate a local path. CSV may represent a
single sheet; do not claim that it preserves a complete multi-sheet workbook.

## Timed YouTube transcripts

Use the installed `youtube-multi-source-research` transcript extractor
(`scripts/extract_transcript.py`) or the Agent Reach YouTube adapter. Resolve
the currently installed skill path from the available skill catalog. A
single supplied YouTube URL can be retrieved directly without a broad
research run or a full-media diagnostic.

The extractor accepts one URL, `--out`, preferred `--lang` values,
`--backend yt-dlp`, and a bounded `--timeout`. It outputs `transcript.json`
(text, start, duration), `transcript.md` (time labels), and `manifest.json`
(source URL, retrieved time, language, and subtitle/ASR type). Preserve these
fields together and link quoted findings back to the matching video/time.
Inspect subtitle availability and errors. An extraction error is not proof
that a video has no subtitles. Audio download and ASR require an explicitly
requested scope and are not an automatic fallback. Never extract browser
cookies or put authentication values in a command or artifact.

These routes are alternatives to the official host's private export APIs;
they do not establish JavaScript API compatibility or private host access.
