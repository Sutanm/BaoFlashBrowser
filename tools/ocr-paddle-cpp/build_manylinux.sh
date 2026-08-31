#!/usr/bin/env bash
set -euo pipefail

workspace="${BAO_WORKSPACE:-/workspace}"
build_root="/tmp/bao-paddle-cpp"
source_root="$workspace/.cache/paddle-cpp/PaddleOCR-release-2.7/deploy/cpp_infer"
inference_archive="$workspace/.cache/paddle-cpp/paddle_inference-2.6.2-linux-cpu-avx-mkl.tgz"
expected_inference_sha="9e85ebe7a11a2074e43969094d8759a251d23102be7d85092e433c5cf2a488a8"
expected_source_commit="8cce9b6fd7ccb50226d0c38f94054d81c29b8184"
output_archive="$workspace/.cache/ocr/paddle-linux-x64-manylinux.tar.gz"

test -d "$source_root"
test -f "$inference_archive"
actual_inference_sha="$(sha256sum "$inference_archive" | awk '{print $1}')"
test "$actual_inference_sha" = "$expected_inference_sha"
actual_source_commit="$(git -C "$source_root/../.." rev-parse HEAD)"
test "$actual_source_commit" = "$expected_source_commit"

rm -rf "$build_root"
mkdir -p "$build_root/inference" "$build_root/build" "$build_root/stage/lib"
tar -xzf "$inference_archive" -C "$build_root/inference"
paddle_root="$build_root/inference/paddle_inference"

cmake -S "$workspace/tools/ocr-paddle-cpp" -B "$build_root/build" -G Ninja \
  -DPADDLE_LIB="$paddle_root" \
  -DPADDLE_OCR_CPP="$source_root"
cmake --build "$build_root/build" --parallel

stage="$build_root/stage"
cp "$build_root/build/bao-paddle-ocr-sidecar" "$stage/bao-paddle-ocr-sidecar"
patchelf --force-rpath --set-rpath '$ORIGIN/lib' "$stage/bao-paddle-ocr-sidecar"

for dependency in \
  "$paddle_root"/paddle/lib/*.so* \
  "$paddle_root"/third_party/install/mklml/lib/*.so* \
  "$paddle_root"/third_party/install/mkldnn/lib/*.so*; do
  test -e "$dependency" || continue
  cp -L "$dependency" "$stage/lib/$(basename "$dependency")"
done

# Copy every non-core dependency resolved by the manylinux build. Core glibc,
# libstdc++ and loader libraries remain target-system dependencies.
while read -r dependency; do
  test "$dependency" = "$stage/lib/$(basename "$dependency")" && continue
  case "$(basename "$dependency")" in
    libc.so.*|libm.so.*|libdl.so.*|librt.so.*|libpthread.so.*|libgcc_s.so.*|libstdc++.so.*|ld-linux-*.so.*) continue ;;
  esac
  cp -L "$dependency" "$stage/lib/$(basename "$dependency")"
done < <(LD_LIBRARY_PATH="$stage/lib" ldd "$stage/bao-paddle-ocr-sidecar" | awk '/=> \// {print $3}' | sort -u)

mkdir -p "$stage/models"
cp -a "$workspace/native/ocr/win64/models/ch_PP-OCRv3_det_infer" "$stage/models/"
cp -a "$workspace/native/ocr/win64/models/ch_PP-OCRv3_rec_infer" "$stage/models/"
cp "$workspace/native/ocr/win64/models/dict_chinese.txt" "$stage/models/dict_chinese.txt"
cp "$source_root/../../LICENSE" "$stage/LICENSE-PaddleOCR"

cat > "$stage/OCR-RUNTIME.json" <<EOF
{
  "protocol": 1,
  "provider": "Paddle Inference",
  "engine": "Paddle Inference C++ 2.6.2 CPU MKL",
  "model": "PP-OCRv3",
  "platform": "linux",
  "arch": "x64",
  "buildBaseline": "manylinux_2_28",
  "paddleOcrCommit": "$expected_source_commit",
  "paddleInferenceSha256": "$expected_inference_sha"
}
EOF

mkdir -p "$(dirname "$output_archive")"
tar -C "$stage" -czf "$output_archive" .
echo "Prepared Paddle Linux runtime: $output_archive"
du -sh "$stage" "$output_archive"
LD_LIBRARY_PATH="$stage/lib" ldd "$stage/bao-paddle-ocr-sidecar"
