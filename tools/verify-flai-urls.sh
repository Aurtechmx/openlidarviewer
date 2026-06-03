#!/bin/bash
# verify-flai.sh — curl-driven verification of FLAI candidate URLs.
# Tests: CORS preflight + HEAD size + ranged GET (1KB) + LAS signature.
# Reports PASS / FAIL per URL.

ORIGIN="http://localhost:5173"

declare -a URLS=(
  "BE|31370|Belgium (DHMV-II 2013–2015)|CC BY 4.0|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/BE/EODaS/LiDAR_DHMV_II-2013-2015/copc/LiDAR_DHMV_2_P1_ATL12104_ES_52500_217000.copc.laz"
  "NL|28992|Netherlands AHN4 (2020–2022)|Public domain|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/NL/AHN/AHN4_2020-2022/copc/C_01CZ1.copc.laz"
  "DK|25832|Denmark SDFI DHM (2018–2022)|Open data|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/DK/SDFI/DHM_2018-2022/copc/PUNKTSKY_1km_6049_684.copc.laz"
  "SI|3794|Slovenia GURS CLSS (2023)|CC BY 4.0|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/SI/GURS/CLSS_2023/copc/GKOT_433_100.copc.laz"
  "ES|25829|Spain CNIG PNOA (2008–2015)|CC BY 4.0|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/ES/CNIG/Lidar_2008-2015_epsg25829/copc/PNOA_2009_Lote1_GAL_508-4636_ORT-CLA-COL.copc.laz"
  "IE|29902|Ireland — Dublin City 2015|CC BY 4.0|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/IE/NYU_EDU/Dublin_City_2015/copc/T_314000_233500.copc.laz"
  "EE|3301|Estonia Maa-amet ALS (2008 madal)|Open data|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/EE/Maa_amet/ALS_2008_madal/copc/466532_2008_madal.copc.laz"
  "FI|3067|Finland NLS 0.5 pt/m² (2008)|CC BY 4.0|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/FI/NLS/05p_year_2008/copc/K4223A2.copc.laz"
  "CH|2056|Switzerland swisssurface3d (2022)|Open data|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz"
  "LU|2169|Luxembourg LiDAR (2019)|CC0|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/LU/Gouvernement_LUX/Lidar_2019/copc/LIDAR2019_NdP_100000_82500_EPSG2169.copc.laz"
  "FR|2154|France IGN HD LiDAR (2021)|Open data|https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/FR/IGN/Lidar_2021/copc/LHD_C_LA93-IGN69_0932-6503_2021.copc.laz"
)

PASS=()
FAIL=()
echo "FLAI Open LiDAR Data — curl verification"
echo "========================================"
for entry in "${URLS[@]}"; do
  IFS='|' read -r country epsg label license url <<< "$entry"
  printf "[%s] %s\n" "$country" "$label"

  # 1. CORS preflight
  ao=$(curl -sI --max-time 12 -X OPTIONS "$url" \
    -H "Origin: $ORIGIN" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: range" 2>/dev/null \
    | grep -i "^access-control-allow-origin" | tr -d '\r')
  if [ -z "$ao" ]; then
    echo "     FAIL · CORS preflight returned nothing"
    FAIL+=("$country|$label|no CORS")
    echo
    continue
  fi

  # 2. HEAD probe
  hdrs=$(curl -sI --max-time 12 "$url" -H "Origin: $ORIGIN" 2>/dev/null)
  len=$(echo "$hdrs" | grep -i "^content-length:" | tr -d '\r' | awk '{print $2}')
  accept=$(echo "$hdrs" | grep -i "^accept-ranges:" | tr -d '\r' | awk '{print $2}')
  if [ -z "$len" ] || [ "$len" -lt 1024 ]; then
    echo "     FAIL · HEAD: len=$len accept=$accept"
    FAIL+=("$country|$label|HEAD failed")
    echo
    continue
  fi
  mb=$(awk "BEGIN { printf \"%.1f\", $len / 1048576 }")

  # 3. Ranged GET first 1024 bytes
  curl -s --max-time 15 "$url" \
    -H "Origin: $ORIGIN" \
    -H "Range: bytes=0-1023" \
    -o /tmp/flai-probe-$country.bin 2>/dev/null
  if [ ! -f /tmp/flai-probe-$country.bin ] || [ ! -s /tmp/flai-probe-$country.bin ]; then
    echo "     FAIL · Ranged GET returned empty"
    FAIL+=("$country|$label|range failed")
    echo
    continue
  fi
  sig=$(head -c 4 /tmp/flai-probe-$country.bin)
  if [ "$sig" != "LASF" ]; then
    echo "     FAIL · Bad signature: '$sig'"
    FAIL+=("$country|$label|bad signature")
    rm -f /tmp/flai-probe-$country.bin
    echo
    continue
  fi
  # Read LAS version (bytes 24-25) + point format (byte 104)
  ver_major=$(xxd -s 24 -l 1 -p /tmp/flai-probe-$country.bin)
  ver_minor=$(xxd -s 25 -l 1 -p /tmp/flai-probe-$country.bin)
  ver_major_dec=$((16#$ver_major))
  ver_minor_dec=$((16#$ver_minor))
  pf_hex=$(xxd -s 104 -l 1 -p /tmp/flai-probe-$country.bin)
  pf=$((16#$pf_hex & 0x3F))

  echo "     PASS · size: ${mb} MB · LAS ${ver_major_dec}.${ver_minor_dec} · format $pf · EPSG $epsg"
  PASS+=("$country|$label|$mb|$epsg|$license|$url")
  rm -f /tmp/flai-probe-$country.bin
  echo
done

echo "========================================"
echo "Summary: ${#PASS[@]} PASS · ${#FAIL[@]} FAIL"
echo
echo "Verified for shipping:"
for p in "${PASS[@]}"; do
  IFS='|' read -r c l mb epsg lic _ <<< "$p"
  printf "  ✓ %s — %s (%s MB · EPSG %s · %s)\n" "$c" "$l" "$mb" "$epsg" "$lic"
done
if [ ${#FAIL[@]} -gt 0 ]; then
  echo
  echo "Drop:"
  for f in "${FAIL[@]}"; do
    IFS='|' read -r c l r <<< "$f"
    printf "  ✗ %s — %s · %s\n" "$c" "$l" "$r"
  done
fi
