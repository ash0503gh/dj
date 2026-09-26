"""
storage.py - Durable storage for uploaded tracks, analyses and keylocked renders.

Without GCS_BUCKET (local runs, Render) everything stays on local disk as before.
With GCS_BUCKET set (Cloud Run), files are also kept in that Cloud Storage bucket so they survive
restarts, scale-to-zero and new instances; the local directories act as a cache.

Bucket layout:
  uploads/<file_id>              the uploaded audio
  analysis/<file_id>.json        full analysis (preset-list fields also stored as object metadata)
  stretch/<name>.flac            keylocked renders
"""

import os
import json
import uuid
from typing import Dict, Iterator, Optional, Tuple

BUCKET = os.environ.get("GCS_BUCKET", "").strip()
_bucket = None


def enabled() -> bool:
    return bool(BUCKET)


def _b():
    global _bucket
    if _bucket is None:
        from google.cloud import storage  # imported only when a bucket is configured
        _bucket = storage.Client().bucket(BUCKET)
    return _bucket


def put_file(key: str, path: str, content_type: Optional[str] = None) -> None:
    if enabled():
        _b().blob(key).upload_from_filename(path, content_type=content_type)


def fetch_file(key: str, path: str) -> bool:
    """Download `key` to `path`. False if the bucket is off or the object doesn't exist."""
    if not enabled():
        return False
    from google.api_core.exceptions import NotFound
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Unique per call: on a fresh instance several requests fetch the same track at once, and a
    # shared temp name let one request rename the file away from under the others
    tmp = f"{path}.{uuid.uuid4().hex}.part"
    try:
        _b().blob(key).download_to_filename(tmp)
    except NotFound:
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    os.replace(tmp, path)
    return True


def put_json(key: str, obj: dict, metadata: Optional[Dict[str, str]] = None) -> None:
    if enabled():
        blob = _b().blob(key)
        if metadata:
            blob.metadata = {k: str(v) for k, v in metadata.items()}
        blob.upload_from_string(json.dumps(obj), content_type="application/json")


def get_json(key: str) -> Optional[dict]:
    if not enabled():
        return None
    from google.api_core.exceptions import NotFound
    try:
        return json.loads(_b().blob(key).download_as_text())
    except NotFound:
        return None


def list_objects(prefix: str) -> Iterator[Tuple[str, str]]:
    """(object name, last update) for every object under `prefix`, without downloading them."""
    if enabled():
        for blob in _b().list_blobs(prefix=prefix):
            yield blob.name, str(blob.updated)


def list_metadata(prefix: str) -> Iterator[Tuple[str, Dict[str, str]]]:
    """(object name, custom metadata) for every object under `prefix`, without downloading them."""
    if enabled():
        for blob in _b().list_blobs(prefix=prefix):
            yield blob.name, (blob.metadata or {})
