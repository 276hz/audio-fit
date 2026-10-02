#!/usr/bin/env bash
# Native-ffmpeg spike: proves the split/verify STRATEGY. It does NOT prove ffmpeg.wasm (see DECISIONS.md).
# Usage: ./spike-native.sh input.flac SPLIT_SAMPLE
set -euo pipefail
IN=$1; SPLIT=$2
ffmpeg -v error -y -i "$IN" -af "atrim=end_sample=$SPLIT,asetpts=N/SR/TB" -c:a flac -compression_level 12 p1.flac
ffmpeg -v error -y -i "$IN" -af "atrim=start_sample=$SPLIT,asetpts=N/SR/TB" -c:a flac -compression_level 12 p2.flac
printf "file 'p1.flac'\nfile 'p2.flac'\n" > list.txt
A=$(ffmpeg -v error -i "$IN" -map 0:a -c:a pcm_s16le -f hash -hash sha256 -)
B=$(ffmpeg -v error -f concat -safe 0 -i list.txt -map 0:a -c:a pcm_s16le -f hash -hash sha256 -)
[ "$A" = "$B" ] && echo "BIT-EXACT $A" || { echo "MISMATCH $A vs $B"; exit 1; }
