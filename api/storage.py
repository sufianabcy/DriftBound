"""Robust-mode model snapshots: Amazon S3 in the cloud, a local folder otherwise.

On EC2 the S3 client finds credentials through the instance's IAM role, so no
access keys are stored anywhere. Snapshots are pickles written and read only by
this application; never load one from a source you do not control.
"""

from __future__ import annotations

from pathlib import Path


class ModelStore:
    def __init__(self, bucket: str = "", local_dir: str = "models", region: str = "ap-south-1"):
        self.bucket = bucket or None
        self.local_dir = Path(local_dir)
        self.region = region
        self._client = None

    @property
    def kind(self) -> str:
        return "s3" if self.bucket else "local"

    def _s3(self):
        if self._client is None:
            import boto3  # imported lazily: local runs never need it

            self._client = boto3.client("s3", region_name=self.region)
        return self._client

    @staticmethod
    def object_name(run_id: str, key: str, step: int) -> str:
        return f"runs/{run_id}/{key.replace(':', '-')}-step{step}.pkl"

    def save(self, run_id: str, key: str, step: int, blob: bytes) -> str:
        """Store one snapshot and return its URI (s3://bucket/... or local://...)."""
        name = self.object_name(run_id, key, step)
        if self.bucket:
            self._s3().put_object(Bucket=self.bucket, Key=name, Body=blob)
            return f"s3://{self.bucket}/{name}"
        path = self.local_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
        return f"local://{name}"

    def load(self, uri: str) -> bytes:
        if uri.startswith("s3://"):
            bucket, _, name = uri.removeprefix("s3://").partition("/")
            return self._s3().get_object(Bucket=bucket, Key=name)["Body"].read()
        if uri.startswith("local://"):
            return (self.local_dir / uri.removeprefix("local://")).read_bytes()
        raise ValueError(f"unknown snapshot location: {uri}")
