# Setting up a new barbershop

A step-by-step for giving another shop its own copy of the MICROSPACE barber app. Part A is a
checklist for the shop owner; Part B is the setup itself, done once on the computer that runs the
app (today that is a Mac with Docker, the same way MICROSPACE runs).

## Part A: what the shop owner decides first

Have these ready before setup. Everything except the currency can be changed later in the app.

1. **Shop name** (for example "MICROSPACE"). It appears in every text message.
2. **Currency** for prices (USD, CAD, GBP...). **This one can't be changed later.**
3. **Time zone** (for example America/Chicago, America/Toronto).
4. **Owner's name and email** (the owner signs in with this email).
5. **Barbers:** each barber's name, sign-in email and usual chair.
6. **Services** and how long each takes (for example Haircut 30 minutes, Skin fade 45, Cut and beard 60), and prices if you want them.
7. Optional: **a barber's own times** for a service, if it differs from the shop's.
8. **Cancellation policy** text, for the missed-appointment message.
9. Optional: changes to the **message wording** (the "time for a cut" and "missed appointment" texts).

## Part B: the setup

You need Git, Node.js 24 or newer, pnpm and Docker Desktop, as in the CRM's README.

1. **Get the app:** download this project (the `barbershop` branch of github.com/micamby/crm) into a folder.
2. **Start the CRM** with the README's Quick start, in order. At the `bootstrap` step, add the shop's
   currency, for example:

       docker compose run --rm api bootstrap --name "Shop name" --email owner@example.com --owner-name "Owner Name" --currency CAD

   Save the two keys it prints in a file that is never uploaded, called `CRM-SECRET-KEYS.txt` on the Desktop.
   Keep the lines exactly as printed: the setup reads the `Admin key` and `Ops key` lines.
3. **Build the command-line tool** (once):

       pnpm install && pnpm --filter @hl-crm-db/sdk build && pnpm --filter hl-crm-db build

4. **Set up the barbershop** in one go (use the shop's time zone):

       python3 barbershop-setup/setup_new_shop.py --timezone America/Toronto

   This installs clients, barbers, services and appointments, renames Contacts to Clients, hides what
   barbershops don't use, and creates the automatic jobs, reminders, starting services, message wording
   and the owner's Barber record. Running it again changes nothing that already exists.
5. **Add each barber:**

       node packages/cli/dist/main.js members add --email barber@example.com --name "Barber Name" --role barber

   Then in the app, open **Barbers**, press **New**, and add their name, the same sign-in email and their
   usual chair. Finally run `python3 barbershop-setup/make_barber_views.py` to create each barber's own lists.
6. **In the app** (sign in with the owner's sign-in link from the Quick start, then set a password):
   - **Services:** check the names, lengths and prices.
   - **Messages:** paste the shop's cancellation policy into "Cancellation policy", and adjust the wording.
   - Optional: **Barber service times** for barbers with their own lengths.
7. **Start the Calendar, Numbers and Texts pages** and have them start by themselves at login:

       SHOP_TIMEZONE=America/Toronto sh barbershop-dashboard/install-autostart.sh

   Then open http://localhost:8790.
8. In **Docker Desktop → Settings → General**, tick **Start Docker Desktop when you sign in**.

## Good to know

- Everything runs on that one computer until the app is put online. Barbers can only use it from that computer for now.
- Use made-up clients while learning. Real client details are personal information: decide how you'll protect them before going online.
- The app is built on the open-source CRM hl-crm-db (AGPL licence). Changes to the CRM's own code that other people use online must be shared; the barbershop setup and your data don't have to be.
