-- Append-only per-site change stream for `glance.db` realtime push + replay. Written in the SAME
-- D1 batch as the mutation it describes, so a client that reconnects (or misses a frame) can catch
-- up from an opaque cursor instead of going permanently stale. `createdBy` is the DOCUMENT's
-- creator captured at mutation time — for a moderating DELETE that is NOT the writer — and carries
-- NO users FK on purpose: cascade would delete the very replay rows a reconnect needs, and SET NULL
-- would erase the identity the fan-out visibility filter reads. The composite primary key is both
-- the per-site uniqueness guarantee for `seq` and the catch-up scan index (siteId, seq > cursor).
CREATE TABLE `change_log` (
	`siteId` text NOT NULL,
	`seq` integer NOT NULL,
	`collection` text NOT NULL,
	`docId` text NOT NULL,
	`createdBy` text NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`siteId`, `seq`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
