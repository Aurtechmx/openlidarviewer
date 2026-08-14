ogrinfo -q -dialect OGRSQL -sql "SELECT id, OGR_GEOM_AREA AS area FROM \"input-polygons\"" input-polygons.geojson
