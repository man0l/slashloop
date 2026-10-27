-- WorkspaceMember.acceptedAt (SLA-1093): membership is email-keyed with no accept
-- flow, so "accepted" = the invitee signed in with that email and loaded their
-- workspace switcher (listWorkspacesForUser stamps it). NULL = invited, not yet seen.
--
-- Mirrors the field in prisma/schema.prisma and prisma/schema.sqlite.prisma.
ALTER TABLE "WorkspaceMember" ADD COLUMN "acceptedAt" DATETIME;
