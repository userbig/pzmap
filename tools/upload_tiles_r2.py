#!/usr/bin/env python3
"""
upload_tiles_r2.py - prints (and, with --run, executes) the shell command
that uploads render/gen/html/map_data/base to an R2 (or other S3-compatible)
bucket for production tile hosting (see web/config.js's tileBase).

This script never touches the network by default: it only prints the
command, so bucket name / credentials / flags can be reviewed before
anything is actually uploaded. Pass --run to execute it via subprocess.

Requires one of the following to already be installed and configured:
    - rclone, with an R2 remote set up (`rclone config`)
    - the aws CLI, with R2 credentials (access key + endpoint URL)

Examples:
    python tools/upload_tiles_r2.py --bucket pzmap-tiles
    python tools/upload_tiles_r2.py --tool aws --bucket pzmap-tiles \\
        --endpoint-url https://<account>.r2.cloudflarestorage.com --run
"""

import argparse
import shlex
import subprocess
import sys
from pathlib import Path

DEFAULT_SOURCE = Path(__file__).resolve().parent.parent / "render" / "gen" / "html" / "map_data" / "base"

# Tiles are immutable build output (see tools/serve.py's cache policy for the
# same reasoning): a re-render always goes to a fresh render/ tree, so a
# long max-age + immutable is safe once a given key has been uploaded once.
CACHE_CONTROL = "public, max-age=31536000, immutable"


def build_rclone_command(source: Path, remote: str, bucket: str, prefix: str) -> list:
    # rclone S3 remotes address objects as remote:bucket/prefix.
    path = "/".join(p for p in (bucket, prefix) if p)
    dest = f"{remote}:{path}" if path else f"{remote}:"
    return [
        "rclone", "sync",
        str(source), dest,
        # rclone sets Content-Type per file from its extension automatically
        # (jpg/webp/dzi/xml) - no extra flag needed for that part.
        "--header-upload", f"Cache-Control: {CACHE_CONTROL}",
        "--transfers", "16",
        "--checkers", "16",
        "--fast-list",
        "--progress",
    ]


def build_aws_command(source: Path, bucket: str, prefix: str, endpoint_url: str, profile: str) -> list:
    dest = f"s3://{bucket}/{prefix}".rstrip("/") if prefix else f"s3://{bucket}"
    cmd = [
        "aws", "s3", "sync",
        str(source), dest,
        # aws s3 sync also guesses Content-Type per file automatically.
        "--cache-control", CACHE_CONTROL,
    ]
    if endpoint_url:
        cmd += ["--endpoint-url", endpoint_url]
    if profile:
        cmd += ["--profile", profile]
    return cmd


def main():
    parser = argparse.ArgumentParser(
        description="Print (or run) the tile upload command for R2/S3.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--tool", choices=["rclone", "aws"], default="rclone",
                         help="CLI to build the command for (default: rclone)")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE),
                         help="Local tile directory to upload (default: render/gen/html/map_data/base)")
    parser.add_argument("--bucket", help="Target bucket name (required with --tool aws)")
    parser.add_argument("--prefix", default="base",
                         help="Key prefix inside the bucket (default: base, matching web/config.js's tileBase layout)")
    parser.add_argument("--remote", default="r2",
                         help="rclone remote name, as set up in `rclone config` (default: r2)")
    parser.add_argument("--endpoint-url",
                         help="R2 S3-compatible endpoint URL (aws only), e.g. https://<account>.r2.cloudflarestorage.com")
    parser.add_argument("--profile", help="AWS CLI profile holding the R2 credentials (aws only)")
    parser.add_argument("--run", action="store_true",
                         help="Actually execute the command instead of just printing it")
    args = parser.parse_args()

    source = Path(args.source)
    if not source.is_dir():
        print(f"warning: source directory not found: {source}", file=sys.stderr)

    if args.tool == "rclone":
        if not args.bucket:
            parser.error("--bucket is required")
        cmd = build_rclone_command(source, args.remote, args.bucket, args.prefix)
    else:
        if not args.bucket:
            parser.error("--bucket is required with --tool aws")
        cmd = build_aws_command(source, args.bucket, args.prefix, args.endpoint_url, args.profile)

    print("Tile upload command:")
    print(" ", shlex.join(cmd))
    print()

    if not args.run:
        print("Dry run - nothing was uploaded. Pass --run to execute this command.")
        return

    print("Running...")
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
