# Demo

The demo is a hiking club that runs an international 32 km walk every year: registrations, payments, hotel rooms, the check-in at the start, stamps at four stations and the finish, and a medal for the tenth participation. It comes as a database and as a Stashley configuration.

## 1. The database

```bash
scripts/seed-demo.sh --network stashley-demo
```

The script starts a MariaDB container (`stashley-demo-db`), creates the schema `wanderverein` with its views, the database users and deterministic data, and prints the connection details. The event of 2026 takes place today, and now is 14:30 on the event day: 205 participants are checked in, 61 have reached the finish, 3 are overdue, and 12 reach their tenth participation. Run it again to start over; the times move along with the clock.

| User | Purpose |
| --- | --- |
| `stashley_read` | Read user |
| `stashley_write` | Write user |
| `stashley_schema` | Schema user for new tables from CSV files |
| `stashley_zuviel` | Has far more privileges than it needs, to see the privilege warnings |

The passwords are printed by the script; they are for local demos only.

## 2. Connect and share

1. Attach Stashley to the same Docker network (`docker network connect stashley-demo <container>`), then add a database in **Administration → Databases**: host `stashley-demo-db`, port 3306, database `wanderverein`, **time zone `UTC`**, the read, write and schema users above. Try `stashley_zuviel` as read user first to see the warnings.
2. Share every table and view with the upper limits of the scenario:

| Object | Upper limit |
| --- | --- |
| `person`, `event`, `hotel`, `hotel_kontingent`, `station`, `anmeldung`, `zahlung` | read, create, update |
| `hotelbuchung` | read, create, update, delete |
| `checkin`, `stempel` | read, create, delete |
| `ehrung` | read, create |
| views | read; key column `anmeldung_id` for `v_zahlungsstatus` and `v_streckenlage`, `person_id` for `v_teilnahmen`, none for `v_medaille` |

## 3. Import the configuration

```bash
node packages/demo/src/cli.ts config > demo-config.json
```

Import the file in **Administration → Configuration**. It brings the roles Orga, Kasse, Check-in, Station, Hotel Lindenhof and Berggasthof Adler, the instance variable `current_event_id`, 16 queries and eleven pages: overview, registrations, participants, cashier, hotels, check-in, station, route status, awards and a guest list per hotel. Then invite accounts and give them roles in **Administration → Users**.

Switch `current_event_id` to the event of 2025 in **Design → Instance variables** to see every page show last year's data.
