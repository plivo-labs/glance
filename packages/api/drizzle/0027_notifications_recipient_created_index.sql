-- Performance: listNotifications orders by (recipientId, createdAt desc) with no readAt predicate,
-- so the existing notifications_recipient_read_created index (recipientId, readAt, createdAt) can't
-- serve the ordering — readAt sits in the middle and forces a full per-recipient scan + temp b-tree
-- sort. This index leads with the exact (recipientId, createdAt) pair the list query needs.
CREATE INDEX IF NOT EXISTS `notifications_recipient_created` ON `notifications` (`recipientId`,`createdAt`);
