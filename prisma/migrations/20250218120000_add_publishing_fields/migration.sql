-- AlterTable
ALTER TABLE `tify_forms` ADD COLUMN `is_published` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `was_published` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `tify_form_fields` ADD COLUMN `is_hidden` BOOLEAN NOT NULL DEFAULT false;
