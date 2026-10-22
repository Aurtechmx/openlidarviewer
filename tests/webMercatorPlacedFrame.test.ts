/**
 * A Web Mercator layer placed away from the project origin.
 *
 * The terrain gather returns project-local coordinates with each layer's
 * placement already applied. The latitude that sets the ground scale is the
 * project origin plus that coordinate: the layer's source origin less its
 * placement offset. Adding the layer's own origin would count the offset twice
 * and scale the run at the wrong latitude.
 */
import { beforeEach, expect, test } from 'vitest';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import { clearTerrainCoreCache } from '../src/terrain/contour/terrainCoreCache';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { webMercatorScaleBound } from '../src/terrain/ground/horizontalScale';

const yOf = (lat: number) => 6378137 * Math.log(Math.tan(Math.PI/4 + lat*Math.PI/360));
const crs = { kind:'projected', epsg:3857, name:'WGS 84 / Pseudo-Mercator', linearUnit:'metre', linearUnitToMetres:1, verticalUnitToMetres:1, source:'las-vlr', confidence:'high', userConfirmed:false } as const;

beforeEach(() => clearTerrainCoreCache());

function harness(placed: boolean) {
  const offset = placed ? 50000 : 0;
  const projectY = yOf(60);
  const sourceY = projectY + offset;
  const points:number[]=[];
  for(let x=0;x<10;x+=0.5) for(let y=0;y<10;y+=0.5) points.push(x,y+offset,0.02*x+0.01*y);
  const positions = Float32Array.from(points);
  const statuses:string[]=[];
  const updates:unknown[]=[];
  const viewer={
    gatherTerrainPositions:()=>({positions, classification:undefined,groundIsDerived:false,residentOnly:false,sampled:false,totalPoints:positions.length/3,withheldExcluded:true,withheldExcludedCount:0,sourceUpAxis:'z'}),
    getCloud:()=>({sourceOrigin:[0,sourceY,0],bounds:()=>({min:[0,0,0],max:[9.5,9.5,0.285]})}),
    layerProjectOffset:()=>placed?[0,offset,0]:null,
    terrainFrameIsSingleOrigin:()=>!placed,
    clouds:()=>placed?['anchor','active']:['active'],
    streamingCloud:null,
  };
  const panel={isVisible:()=>true,setBusy:()=>{},setStatus:(s:string)=>statuses.push(s),update:(r:unknown)=>updates.push(r),setContourFrame:()=>{}};
  const runner=createTerrainAnalysisRunner({getViewer:()=>viewer as never,getAnalysePanel:()=>panel as never,getActiveId:()=> 'active',crsService:{current:()=>crs,context:()=>spatialContextFrom(crs),crsRevision:()=>0}});
  const expected=webMercatorScaleBound(sourceY,sourceY+9.5).groundPerGrid;
  return {runner,statuses,updates,expected};
}

test('an unplaced Web Mercator layer is scaled at its real northing',async()=>{
  const h=harness(false);
  await h.runner.run();
  expect(h.updates.length).toBe(1);
  expect(h.runner.getLastGroundUnitToMetres()).toBeCloseTo(h.expected,10);
});

test('a placed Web Mercator layer is scaled at its project northing, not with its placement added twice',async()=>{
  const h=harness(true);
  await h.runner.run();
  const actual=h.runner.getLastGroundUnitToMetres();
  expect(h.updates.length===0 || (actual!==null && Math.abs(actual/h.expected-1)<1e-8)).toBe(true);
});

