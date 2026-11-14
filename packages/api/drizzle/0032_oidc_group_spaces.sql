-- Group-synced spaces (lib/oidc-access.ts). SQLite cannot ADD COLUMN with a UNIQUE constraint, so
-- the uniqueness drizzle declares on the column is a separate index, named the way drizzle-kit
-- names it. NULL (every space not owned by the IdP) is not constrained by a UNIQUE index.
ALTER TABLE `spaces` ADD COLUMN `oidcGroup` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_oidcGroup_unique` ON `spaces` (`oidcGroup`);
--> statement-breakpoint
-- A managed space's createdBy is only its first member, but the FK cascades: deleting that user
-- would delete the space and every member's sites in it. Hand it to another member first; with
-- none left, NOT NULL aborts the delete instead. (Making the column nullable needs a `spaces`
-- rebuild, and its DROP TABLE fires those same cascades on D1.)
CREATE TRIGGER `users_hand_over_managed_spaces` BEFORE DELETE ON `users` BEGIN
	UPDATE `spaces` SET `createdBy` = (
		SELECT `userId` FROM `space_members` WHERE `spaceId` = `spaces`.`id` AND `userId` <> OLD.`id` LIMIT 1
	) WHERE `createdBy` = OLD.`id` AND `oidcGroup` IS NOT NULL;
END;
