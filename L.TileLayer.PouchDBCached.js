L.TileLayer.addInitHook(function() {

    if (!this.options.useCache) {
        this._db = null;
        this._canvas = null;
        return;
    }

    this._db = new PouchDB('offline-tiles', {
        adapter: 'websql'
    });
    this._canvas = document.createElement('canvas');

    if (!(this._canvas.getContext && this._canvas.getContext('2d'))) {
        // HTML5 canvas is needed to pack the tiles as base64 data. If
        //   the browser doesn't support canvas, the code will forcefully
        //   skip caching the tiles.
        this._canvas = null;
    }
});

L.TileLayer.prototype.options.useCache = false;
L.TileLayer.prototype.options.saveToCache = true;
L.TileLayer.prototype.options.useOnlyCache = false;
L.TileLayer.prototype.options.cacheMaxAge = 24 * 3600 * 1000;


L.TileLayer.include({

    // Overwrites L.TileLayer.prototype._loadTile
    _loadTile: function(tile, tilePoint) {
        tile._layer = this;
        tile.onerror = this._tileOnError;

        this._adjustTilePoint(tilePoint);

        var tileUrl = this.getTileUrl(tilePoint);
        this.fire('tileloadstart', {
            tile: tile,
            url: tileUrl
        });

        if (this.options.useCache && this._canvas) {
            this._db.get(tileUrl, {
                revs_info: true
            }, this._onCacheLookup(tile, tileUrl));
        } else {
            // Fall back to standard behaviour
            tile.onload = this._tileOnLoad;
            tile.src = tileUrl;
        }
    },

    // Returns a callback (closure over tile/key/originalSrc) to be run when the DB
    //   backend is finished with a fetch operation.
    _onCacheLookup: function(tile, tileUrl) {
        return function(err, data) {
            if (data) {
                this.fire('tilecachehit', {
                    tile: tile,
                    url: tileUrl
                });
                if (Date.now() > data.timestamp + this.options.cacheMaxAge && !this.options.useOnlyCache) {
                    // Tile is too old, try to refresh it

                    if (this.options.saveToCache) {
                        tile.onload = this._saveTile(tileUrl, data._revs_info[0].rev);
                    }
                    tile.setAttribute('crossOrigin', 'Anonymous');
                    tile.src = tileUrl;
                    tile.onerror = function(ev) {
                        // If the tile is too old but couldn't be fetched from the network,
                        //   serve the one still in cache.
                        this.src = data.dataUrl;
                    };
                } else {
                    // Serve tile from cached data
                    var tries = 5;
                    tile.removeAttribute('crossOrigin');
                    tile.onload = this._tileOnLoad;
                    tile.onerror = function(ev, blah) {};
                    tile.src = data.dataUrl; // data.dataUrl is already a base64-encoded PNG image.

                }
            } else {
                this.fire('tilecachemiss', {
                    tile: tile,
                    url: tileUrl
                });
                if (this.options.useOnlyCache) {
                    // Offline, not cached
                    tile.onload = this._tileOnLoad;
                    tile.src = L.Util.emptyImageUrl;
                } else {
                    // Online, not cached, request the tile normally
                    if (this.options.saveToCache) {
                        tile.onload = this._saveTile(tileUrl);
                    } else {
                        tile.onload = this._tileOnLoad;
                    }
                    tile.setAttribute('crossOrigin', 'Anonymous');
                    tile.src = tileUrl;
                }
            }
        }.bind(this);
    },

    // Returns an event handler (closure over DB key), which runs
    //   when the tile (which is an <img>) is ready.
    // The handler will delete the document from pouchDB if an existing revision is passed.
    //   This will keep just the latest valid copy of the image in the cache.
    _saveTile: function(tileUrl, existingRevision) {
        return function(ev) {
            if (this._canvas === null) return;
            var img = ev.target;
            img.setAttribute('crossOrigin', 'Anonymous');
            L.TileLayer.prototype._tileOnLoad.call(img, ev);
            this._canvas.width = img.naturalWidth || img.width;
            this._canvas.height = img.naturalHeight || img.height;

            var context = this._canvas.getContext('2d');
            context.drawImage(img, 0, 0);

            var dataUrl = this._canvas.toDataURL('image/png');
            var doc = {
                dataUrl: dataUrl,
                timestamp: Date.now()
            };

            if (existingRevision) {
                this._db.remove(tileUrl, existingRevision);
            }
            this._db.put(doc, tileUrl, doc.timestamp);
        }.bind(this);
    },


    // Seeds the cache given a bounding box (latLngBounds), and
    //   the minimum and maximum zoom levels
    // Use with care! This can spawn thousands of requests and
    //   flood tileservers!
    seed: function(points, lines, bbox, minZoom, maxZoom, feet, callback) {
        if (minZoom > maxZoom) return;
        if (!this._map) return;

        var boxes = [];
        var map = {};
        var queue = [];

        var buffer = feet / 6 * 0.0001;

        if (points) {
            for (var i = 0; i < points.length; i++) {
                boxes.push(makeBox(points[i], buffer));
            }
        }

        if (lines) {
            for (var i = 0; i < lines.length; i++) {
                for (var a = 0; a < lines[i].length; a++) {
                    if (lines[i][a - 1]) {
                        var distance = getDistance(lines[i][a - 1], lines[i][a]);
                        if (distance > buffer) {
                            var extras = getMiddles(lines[i][a - 1], lines[i][a], distance / buffer);
                            for (var x = 0; x < extras.length; x++) {
                                boxes.push(makeBox(extras[x], buffer));
                            }
                        }
                    }
                    boxes.push(makeBox(lines[i][a], buffer));
                }
            }
        }


        for (var w = 0; w < boxes.length; w++) {
            for (var z = minZoom; z < maxZoom + 1; z++) {
                if (!map[z]) {
                    map[z] = {};
                }

                var northEastPoint = this._map.project(boxes[w].getNorthEast(), z);
                var southWestPoint = this._map.project(boxes[w].getSouthWest(), z);

                // Calculate tile indexes as per L.TileLayer._update and
                //   L.TileLayer._addTilesFromCenterOut
                var tileSize = this._getTileSize();
                var tileBounds = L.bounds(
                    northEastPoint.divideBy(tileSize)._floor(),
                    southWestPoint.divideBy(tileSize)._floor());

                for (var j = tileBounds.min.y; j <= tileBounds.max.y; j++) {
                    if (!map[z][j]) {
                        map[z][j] = {};
                    }
                    for (var a = tileBounds.min.x; a <= tileBounds.max.x; a++) {
                        if (!map[z][j][a]) {
                            point = new L.Point(a, j);
                            point.z = z;
                            map[z][j][a] = true;
                            queue.push(this.getTileUrl(point));
                        }
                    }
                }
            }
        }


        var seedData = {
            bbox: bbox,
            minZoom: minZoom,
            maxZoom: maxZoom,
            queueLength: queue.length
        };
        this.fire('seedstart', seedData);
        var tile = this._createTile();
        tile._layer = this;
        this._seedOneTile(tile, queue, seedData);

        function makeBox(point, buffer) {
            var coords = [
                point[0] - buffer,
                point[1] - buffer,
                point[0] + buffer,
                point[1] + buffer,
            ];
            return L.latLngBounds(L.latLng(coords[0], coords[1]), L.latLng(coords[2], coords[3]));
        }

        function getDistance(start, end) {
            var xs = 0;
            var ys = 0;

            xs = end[1] - start[1];
            xs = xs * xs;

            ys = end[0] - start[0];
            ys = ys * ys;

            return Math.sqrt(xs + ys);
        }

        function getMiddles(start, end, count) {

            var coords = [];

            for (var i = 0; i < count - 1; i++) {
                var x = start[1] + (end[1] - start[1]) * (i + 1) / count;
                var y = start[0] + (end[0] - start[0]) * (i + 1) / count;

                coords.push([x, y]);
            }

            return coords;
        }
    },

    // Uses a defined tile to eat through one item in the queue and
    //   asynchronously recursively call itself when the tile has
    //   finished loading.
    _seedOneTile: function(tile, remaining, seedData) {
        if (!remaining.length) {
            this.fire('seedend', seedData);
            return;
        }
        this.fire('seedprogress', {
            bbox: seedData.bbox,
            minZoom: seedData.minZoom,
            maxZoom: seedData.maxZoom,
            queueLength: seedData.queueLength,
            remainingLength: remaining.length
        });

        var url = remaining.pop();

        this._db.get(url, function(err, data) {
            if (!data) {
                /// FIXME: Do something on tile error!!
                tile.onload = function(ev) {
                    this._saveTile(url)(ev);
                    this._seedOneTile(tile, remaining, seedData);
                }.bind(this);
                tile.setAttribute('crossOrigin', 'Anonymous');
                tile.src = url;
            } else {
                this._seedOneTile(tile, remaining, seedData);
            }
        }.bind(this));

    }

});
