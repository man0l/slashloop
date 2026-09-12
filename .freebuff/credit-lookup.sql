SELECT id, email FROM "User" WHERE lower(email) = 'manol.trendafilov@gmail.com';
SELECT id, name, ownerId, planKey, planCredits, packCredits, createdAt
  FROM "Workspace"
 WHERE ownerId IN (SELECT id FROM "User" WHERE lower(email) = 'manol.trendafilov@gmail.com')
 ORDER BY createdAt ASC;
