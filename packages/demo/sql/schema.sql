-- SPDX-FileCopyrightText: 2026 Stashley contributors
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Schema of the demo scenario "Wanderverein" (hiking club). Runs on MariaDB and MySQL.
-- The demo data comes from `@stashley/demo` (`scripts/seed-demo.sh`).

CREATE TABLE person (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  vorname VARCHAR(80) NOT NULL,
  nachname VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL,
  land CHAR(2) NOT NULL,
  telefon VARCHAR(40) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY person_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE event (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  jahr SMALLINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  datum DATE NOT NULL,
  startort VARCHAR(120) NOT NULL,
  strecke_km DECIMAL(5,1) NOT NULL,
  ticketpreis DECIMAL(8,2) NOT NULL,
  anmeldeschluss DATE NOT NULL,
  UNIQUE KEY event_jahr (jahr)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE anmeldung (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  person_id BIGINT NOT NULL,
  event_id BIGINT NOT NULL,
  ticket_typ ENUM('standard','ermaessigt','helfer') NOT NULL DEFAULT 'standard',
  status ENUM('angemeldet','storniert') NOT NULL DEFAULT 'angemeldet',
  startnummer INT NULL,
  betrag_soll DECIMAL(8,2) NOT NULL,
  angemeldet_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY anmeldung_person (event_id, person_id),
  UNIQUE KEY anmeldung_startnummer (event_id, startnummer),
  CONSTRAINT anmeldung_person_fk FOREIGN KEY (person_id) REFERENCES person (id),
  CONSTRAINT anmeldung_event_fk FOREIGN KEY (event_id) REFERENCES event (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE hotel (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  ort VARCHAR(120) NOT NULL,
  kontakt_email VARCHAR(254) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE hotel_kontingent (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  zimmerart VARCHAR(40) NOT NULL,
  preis_nacht DECIMAL(8,2) NOT NULL,
  anzahl INT NOT NULL,
  CONSTRAINT hotel_kontingent_event_fk FOREIGN KEY (event_id) REFERENCES event (id),
  CONSTRAINT hotel_kontingent_hotel_fk FOREIGN KEY (hotel_id) REFERENCES hotel (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE hotelbuchung (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  anmeldung_id BIGINT NOT NULL,
  hotel_kontingent_id BIGINT NOT NULL,
  anreise DATE NOT NULL,
  abreise DATE NOT NULL,
  betrag_soll DECIMAL(8,2) NOT NULL,
  eingecheckt_am DATETIME NULL,
  CONSTRAINT hotelbuchung_anmeldung_fk FOREIGN KEY (anmeldung_id) REFERENCES anmeldung (id),
  CONSTRAINT hotelbuchung_kontingent_fk FOREIGN KEY (hotel_kontingent_id) REFERENCES hotel_kontingent (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE zahlung (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  anmeldung_id BIGINT NOT NULL,
  betrag DECIMAL(8,2) NOT NULL,
  eingang_am DATE NOT NULL,
  verwendungszweck VARCHAR(140) NULL,
  kommentar VARCHAR(500) NULL,
  CONSTRAINT zahlung_anmeldung_fk FOREIGN KEY (anmeldung_id) REFERENCES anmeldung (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE station (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT NOT NULL,
  nummer SMALLINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  km DECIMAL(5,1) NOT NULL,
  oeffnet TIME NOT NULL,
  schliesst TIME NOT NULL,
  ist_ziel BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY station_nummer (event_id, nummer),
  CONSTRAINT station_event_fk FOREIGN KEY (event_id) REFERENCES event (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE checkin (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  anmeldung_id BIGINT NOT NULL,
  eingecheckt_am DATETIME NOT NULL,
  stempelkarte_nr VARCHAR(20) NOT NULL,
  UNIQUE KEY checkin_anmeldung (anmeldung_id),
  CONSTRAINT checkin_anmeldung_fk FOREIGN KEY (anmeldung_id) REFERENCES anmeldung (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE stempel (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  anmeldung_id BIGINT NOT NULL,
  station_id BIGINT NOT NULL,
  zeitpunkt DATETIME NOT NULL,
  UNIQUE KEY stempel_station (anmeldung_id, station_id),
  CONSTRAINT stempel_anmeldung_fk FOREIGN KEY (anmeldung_id) REFERENCES anmeldung (id),
  CONSTRAINT stempel_station_fk FOREIGN KEY (station_id) REFERENCES station (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE ehrung (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  person_id BIGINT NOT NULL,
  event_id BIGINT NOT NULL,
  art ENUM('medaille_10') NOT NULL,
  uebergeben_am DATETIME NULL,
  CONSTRAINT ehrung_person_fk FOREIGN KEY (person_id) REFERENCES person (id),
  CONSTRAINT ehrung_event_fk FOREIGN KEY (event_id) REFERENCES event (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Number of events per person with a check-in, including earlier years.
CREATE VIEW v_teilnahmen AS
SELECT a.person_id, COUNT(DISTINCT a.event_id) AS teilnahmen
  FROM anmeldung a
  JOIN checkin c ON c.anmeldung_id = a.id
 GROUP BY a.person_id;

-- Amount due (ticket plus hotel), paid and open per registration.
CREATE VIEW v_zahlungsstatus AS
SELECT a.id AS anmeldung_id,
       a.event_id,
       a.betrag_soll + COALESCE(h.soll, 0) AS soll,
       COALESCE(z.ist, 0) AS ist,
       a.betrag_soll + COALESCE(h.soll, 0) - COALESCE(z.ist, 0) AS offen,
       CASE
         WHEN COALESCE(z.ist, 0) >= a.betrag_soll + COALESCE(h.soll, 0) THEN 'bezahlt'
         WHEN COALESCE(z.ist, 0) > 0 THEN 'teilbezahlt'
         ELSE 'offen'
       END AS status
  FROM anmeldung a
  LEFT JOIN (SELECT anmeldung_id, SUM(betrag_soll) AS soll FROM hotelbuchung GROUP BY anmeldung_id) h
    ON h.anmeldung_id = a.id
  LEFT JOIN (SELECT anmeldung_id, SUM(betrag) AS ist FROM zahlung GROUP BY anmeldung_id) z
    ON z.anmeldung_id = a.id;

-- Last station per checked-in registration; the check-in counts as the start.
CREATE VIEW v_streckenlage AS
SELECT a.id AS anmeldung_id,
       a.event_id,
       a.startnummer,
       s.id AS station_id,
       COALESCE(s.name, 'Start') AS letzte_station,
       COALESCE(st.zeitpunkt, c.eingecheckt_am) AS zeitpunkt,
       TIMESTAMPDIFF(MINUTE, COALESCE(st.zeitpunkt, c.eingecheckt_am), NOW()) AS minuten_seit,
       COALESCE(s.ist_ziel, FALSE) AS im_ziel
  FROM anmeldung a
  JOIN checkin c ON c.anmeldung_id = a.id
  LEFT JOIN stempel st ON st.id = (
    SELECT s2.id FROM stempel s2
     WHERE s2.anmeldung_id = a.id
     ORDER BY s2.zeitpunkt DESC, s2.id DESC
     LIMIT 1
  )
  LEFT JOIN station s ON s.id = st.station_id;

-- Participation count up to each event; candidates have exactly 10 and no award yet.
CREATE VIEW v_medaille AS
SELECT t.person_id,
       t.event_id,
       t.teilnahme_nr,
       (t.teilnahme_nr = 10 AND NOT EXISTS (
         SELECT 1 FROM ehrung e
          WHERE e.person_id = t.person_id AND e.event_id = t.event_id AND e.art = 'medaille_10'
       )) AS kandidat
  FROM (
    SELECT a.person_id,
           a.event_id,
           COUNT(*) OVER (
             PARTITION BY a.person_id ORDER BY ev.jahr
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS teilnahme_nr
      FROM anmeldung a
      JOIN checkin c ON c.anmeldung_id = a.id
      JOIN event ev ON ev.id = a.event_id
  ) t;
