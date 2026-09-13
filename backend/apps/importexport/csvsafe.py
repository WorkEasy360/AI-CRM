"""CSV safety: upload validation, size/row caps and spreadsheet formula neutralisation (T12, T13, T19)."""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterator
from decimal import Decimal, InvalidOperation
from typing import Any

from rest_framework.exceptions import ValidationError

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_ROWS = 10_000
MAX_COLUMNS = 60
MAX_HEADER_LENGTH = 100
MAX_CELL_LENGTH = 5_000
SNIFF_BYTES = 8 * 1024

FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r", "\n")
_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")
_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._ -]")

csv.field_size_limit(MAX_CELL_LENGTH * 4)


def neutralise(value: Any) -> str:
    """Make a cell inert for spreadsheet applications.

    Cells that a spreadsheet would evaluate (leading ``= + - @`` or control characters) are prefixed
    with a single quote; plain negative numbers are left alone so numeric columns stay usable. Pipes
    are neutralised as well because some applications treat ``|`` as a DDE separator.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal | int | float):
        return str(value)
    text = str(value)
    if not text:
        return ""
    if text[0] in FORMULA_TRIGGERS and not _NUMBER_RE.match(text):
        text = "'" + text
    if "|" in text and text[0] != "'":
        text = "'" + text
    return text.replace("\x00", "")


def safe_filename(name: str, *, default: str = "upload.csv") -> str:
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = _FILENAME_SAFE.sub("_", name).strip(" .")
    return (name or default)[:120]


def validate_upload(uploaded: Any) -> tuple[bytes, list[str], int]:
    """Validate an uploaded CSV. Returns (raw bytes, headers, data row count).

    Checks: extension, size, binary content (NUL bytes / non-UTF-8), header shape, column and row caps,
    cell length cap. The whole file is parsed once so a malformed file is rejected before it is stored.
    """
    name = safe_filename(getattr(uploaded, "name", ""))
    if not name.lower().endswith(".csv"):
        raise ValidationError({"file": "Only .csv files are accepted."})
    size = getattr(uploaded, "size", None)
    if size is None or size <= 0:
        raise ValidationError({"file": "The file is empty."})
    if size > MAX_UPLOAD_BYTES:
        raise ValidationError({"file": f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."})
    raw = uploaded.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValidationError({"file": "The file is too large."})
    head = raw[:SNIFF_BYTES]
    if b"\x00" in head:
        raise ValidationError({"file": "The file does not look like a text CSV file."})
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValidationError({"file": "The file must be UTF-8 encoded."}) from exc
    headers, count = _scan(text)
    return raw, headers, count


def _scan(text: str) -> tuple[list[str], int]:
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        headers = next(reader)
    except StopIteration as exc:
        raise ValidationError({"file": "The file has no header row."}) from exc
    except csv.Error as exc:
        raise ValidationError({"file": "The file is not valid CSV."}) from exc
    headers = [h.strip().replace("\x00", "") for h in headers]
    if not headers or all(not h for h in headers):
        raise ValidationError({"file": "The header row is empty."})
    if len(headers) > MAX_COLUMNS:
        raise ValidationError({"file": f"At most {MAX_COLUMNS} columns are supported."})
    if any(len(h) > MAX_HEADER_LENGTH for h in headers):
        raise ValidationError({"file": "A column header is too long."})
    if len({h.lower() for h in headers if h}) != len([h for h in headers if h]):
        raise ValidationError({"file": "Column headers must be unique."})
    count = 0
    try:
        for row in reader:
            if not any(cell.strip() for cell in row):
                continue
            count += 1
            if count > MAX_ROWS:
                raise ValidationError({"file": f"At most {MAX_ROWS} rows per import. Split the file."})
            if len(row) > len(headers):
                raise ValidationError({"file": f"Row {count + 1} has more cells than the header."})
            if any(len(cell) > MAX_CELL_LENGTH for cell in row):
                raise ValidationError({"file": f"Row {count + 1} has a cell longer than {MAX_CELL_LENGTH} characters."})
    except csv.Error as exc:
        raise ValidationError({"file": "The file is not valid CSV."}) from exc
    if count == 0:
        raise ValidationError({"file": "The file has no data rows."})
    return headers, count


def iter_rows(raw: bytes, headers: list[str]) -> Iterator[tuple[int, dict[str, str]]]:
    """Yield (1-based data row number, {header: cell}) skipping blank rows."""
    reader = csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline=""))
    next(reader, None)
    n = 0
    for row in reader:
        if not any(cell.strip() for cell in row):
            continue
        n += 1
        yield n, {headers[i]: (row[i] if i < len(row) else "") for i in range(len(headers)) if headers[i]}


def parse_decimal(value: str) -> Decimal | None:
    value = (value or "").strip().replace(",", "")
    if not value:
        return None
    try:
        return Decimal(value)
    except InvalidOperation as exc:
        raise ValidationError("Expected a number.") from exc
