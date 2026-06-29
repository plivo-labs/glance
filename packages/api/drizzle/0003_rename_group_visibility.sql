-- Rename the `group` visibility tier to `members`. The tier means the same thing (this space's
-- members, not the whole org); only the label changed (the word collided with space *type* and
-- the share-modal's group picker). `visibility` is a plain text column (no CHECK), so a data
-- update suffices — no table rebuild.
UPDATE `sites` SET `visibility` = 'members' WHERE `visibility` = 'group';
