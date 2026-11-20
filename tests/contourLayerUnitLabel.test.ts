import { describe, it, expect } from 'vitest';
import { contourLayerVerticalUnitLabel } from '../src/app/terrainAnalysisRunner';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { crsFromWkt } from '../src/io/crs';

const UTM_NAVD =
  'COMPD_CS["UTM 12N + NAVD88",PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]],VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["metre",1],AUTHORITY["EPSG","5703"]]]';

const SP_FTUS =
  'PROJCS["NAD83 / California zone 5 (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["standard_parallel_1",35.46666666666667],PARAMETER["standard_parallel_2",34.03333333333333],PARAMETER["latitude_of_origin",33.5],PARAMETER["central_meridian",-118],PARAMETER["false_easting",6561666.667],PARAMETER["false_northing",1640416.667],UNIT["US survey foot",0.3048006096012192,AUTHORITY["EPSG","9003"]],AUTHORITY["EPSG","2229"]]';

const COMPD_FTUS =
  `COMPD_CS["NAD83 / California zone 5 (ftUS) + NAVD88 ft",${SP_FTUS},VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["US survey foot",0.3048006096012192],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","6360"]]]`;

describe('contourLayerVerticalUnitLabel', () => {
  it('shows no unit when the scan has no CRS', () => {
    expect(contourLayerVerticalUnitLabel(spatialContextFrom(null))).toBeNull();
  });

  it('shows m for UTM with NAVD88 metres', () => {
    expect(contourLayerVerticalUnitLabel(spatialContextFrom(crsFromWkt(UTM_NAVD)))).toBe('m');
  });

  it('shows ft for a US-foot compound', () => {
    expect(contourLayerVerticalUnitLabel(spatialContextFrom(crsFromWkt(COMPD_FTUS)))).toBe('ft');
  });
});
