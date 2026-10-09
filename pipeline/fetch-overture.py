import duckdb, time
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
B = dict(xmin=77.6285, xmax=77.6560, ymin=12.9075, ymax=12.9265)
out = "/Users/bishashcosx/Documents/Codes/personal/sakura-run-hsr/data/overture-buildings.json"
t = time.time()
q = f"""
COPY (
  SELECT id,
         class, subtype,
         height, num_floors, num_floors_underground,
         names.primary AS name,
         sources[1].dataset AS source,
         ST_AsGeoJSON(geometry) AS geom
  FROM read_parquet('s3://overturemaps-us-west-2/release/2026-07-22.0/theme=buildings/type=building/*')
  WHERE bbox.xmin > {B['xmin']} AND bbox.xmax < {B['xmax']}
    AND bbox.ymin > {B['ymin']} AND bbox.ymax < {B['ymax']}
) TO '{out}' (FORMAT JSON, ARRAY false);
"""
con.execute(q)
print("done", f"{time.time()-t:.0f}s")
