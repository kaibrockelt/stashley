-- SPDX-FileCopyrightText: 2026 Stashley contributors
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Database users of the demo scenario. The passwords are for local demos and tests only.
-- `stashley_zuviel` has more privileges than it needs, so the grant check warns about it.

DROP USER IF EXISTS 'stashley_read'@'%', 'stashley_write'@'%', 'stashley_schema'@'%', 'stashley_zuviel'@'%';

CREATE USER 'stashley_read'@'%' IDENTIFIED BY 'demo-read-password';
GRANT SELECT, SHOW VIEW ON wanderverein.* TO 'stashley_read'@'%';

CREATE USER 'stashley_write'@'%' IDENTIFIED BY 'demo-write-password';
GRANT SELECT, INSERT, UPDATE ON wanderverein.* TO 'stashley_write'@'%';
GRANT DELETE ON wanderverein.hotelbuchung TO 'stashley_write'@'%';
GRANT DELETE ON wanderverein.checkin TO 'stashley_write'@'%';
GRANT DELETE ON wanderverein.stempel TO 'stashley_write'@'%';

CREATE USER 'stashley_schema'@'%' IDENTIFIED BY 'demo-schema-password';
GRANT CREATE, INSERT ON wanderverein.* TO 'stashley_schema'@'%';

CREATE USER 'stashley_zuviel'@'%' IDENTIFIED BY 'demo-zuviel-password';
GRANT SELECT, SHOW VIEW, INSERT, UPDATE, DELETE, DROP, ALTER ON wanderverein.* TO 'stashley_zuviel'@'%';
GRANT FILE, PROCESS ON *.* TO 'stashley_zuviel'@'%';
GRANT SELECT ON mysql.* TO 'stashley_zuviel'@'%';
