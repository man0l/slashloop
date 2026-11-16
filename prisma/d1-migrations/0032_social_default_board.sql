-- Pinterest default board per account (SLA-1575). A lane holds at most one Pinterest account,
-- so this is the lane's default. Used when a post's settings carry no boardId; NULL = none set.
ALTER TABLE social_integrations ADD COLUMN default_board_id TEXT;
