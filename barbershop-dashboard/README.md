# MICROSPACE numbers page

A small read-only page that reads the CRM and shows the shop's numbers: rebook rate per barber
(booked before leaving or within 3 days after), cuts this week, new clients, the call-back list,
no-shows and busiest days. The CRM has no reports screen of its own yet, so this fills that gap.

Run it (the CRM must be running in Docker):

    node barbershop-dashboard/server.mjs

then open http://localhost:8790. It only listens on this computer. It reads the CRM's ops key from
`~/Desktop/CRM-SECRET-KEYS.txt` (or `HLCRM_OPS_KEY`), and never writes anything.
