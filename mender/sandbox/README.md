# Parcel sandbox API

A read-only copy of Parcel's two versions, served as plain files so Mender Studio can make real HTTP calls
without a backend. `GET sandbox/<version>/orders/<id>` returns that order as the version returns it.

Versions: `2026-03-01` (old) and `2026-09-01` (new). Orders: `ord_1001`, `ord_1002`, `ord_1004`, `ord_1005`.
Generated from `src/parcel.js`.
