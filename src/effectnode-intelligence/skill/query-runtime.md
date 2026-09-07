# Query Runtime

## Check health

make a http GET request to "http://localhost:4343/api/health"

## Query the scene graph

make a http GET request to "http://localhost:4343/api/query/scene"
— returns the scene graph digest (every node with name / type / material).

## Query scene performance

make a http GET request to "http://localhost:4343/api/query/performance"
— returns the performance insight for the 3d scene (geometry & per-object cost,
plus live frame-rate / frame-budget / effect timing).
