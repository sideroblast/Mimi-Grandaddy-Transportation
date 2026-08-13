import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const sb = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: window.localStorage
    }
  }
);

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const ACCESS_EMAIL_KEY = "familyAccessEmail";

const els = {
  login: $("#login"),
  app: $("#app"),
  loginForm: $("#loginForm"),
  email: $("#email"),
  loginMsg: $("#loginMsg"),
  signOut: $("#signOut"),

  needsBanner: $("#needsBanner"),
  needsText: $("#needsText"),
  addBtn: $("#addBtn"),
  mobileAdd: $("#mobileAdd"),
  viewTitle: $("#viewTitle"),
  viewHelp: $("#viewHelp"),
  events: $("#events"),
  empty: $("#empty"),

  eventDialog: $("#eventDialog"),
  eventForm: $("#eventForm"),
  eventHeading: $("#eventHeading"),
  eventId: $("#eventId"),
  person: $("#person"),
  title: $("#title"),
  date: $("#date"),
  time: $("#time"),
  pickupTime: $("#pickupTime"),
  location: $("#location"),
  notes: $("#notes"),
  deleteBtn: $("#deleteBtn"),
  closeEvent: $("#closeEvent"),
  cancelEvent: $("#cancelEvent"),

  detailDialog: $("#detailDialog"),
  detailPerson: $("#detailPerson"),
  detailTitle: $("#detailTitle"),
  detailBody: $("#detailBody"),
  driverBox: $("#driverBox"),
  closeDetail: $("#closeDetail"),
  calendarBtn: $("#calendarBtn"),
  editBtn: $("#editBtn"),

  agencyDialog: $("#agencyDialog"),
  agencyForm: $("#agencyForm"),
  agencyName: $("#agencyName"),
  closeAgency: $("#closeAgency"),
  cancelAgency: $("#cancelAgency"),

  nameDialog: $("#nameDialog"),
  nameForm: $("#nameForm"),
  displayName: $("#displayName"),

  toast: $("#toast")
};

let currentUser = null;
let profile = null;
let allEvents = [];
let currentView = "upcoming";
let selectedEvent = null;
let realtimeChannel = null;
let pendingAgencyEventId = null;

const esc = (v = "") =>
  String(v).replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));

const toDate = e =>
  new Date(
    `${e.event_date}T${String(e.event_time || "00:00").slice(0, 5)}:00`
  );

const isPast = e => toDate(e) < new Date();

const isCovered = e =>
  Boolean(e.driver_user_id || e.driver_email || e.agency_covered);

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;

  clearTimeout(showToast.timer);

  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2500);
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(`${date}T12:00:00`));
}

function formatTime(time) {
  const [h, m] = (time || "00:00")
    .split(":")
    .map(Number);

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(2000, 0, 1, h, m));
}

function agencyStatus(event) {
  return event.agency_name
    ? `✓ ${esc(event.agency_name)} is providing transportation`
    : "✓ Agency is covering transportation";
}

function closeEventDialog() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  els.eventDialog.close();
  window.scrollTo({ left: 0, behavior: "instant" });
}

function getSavedEmail() {
  return (localStorage.getItem(ACCESS_EMAIL_KEY) || "")
    .trim()
    .toLowerCase();
}

function saveAccessEmail(email) {
  localStorage.setItem(
    ACCESS_EMAIL_KEY,
    email.trim().toLowerCase()
  );
}

function clearAccessEmail() {
  localStorage.removeItem(ACCESS_EMAIL_KEY);
}

function buildProfile(email) {
  const normalizedEmail = email.trim().toLowerCase();

  return {
    email: normalizedEmail,
    display_name:
      localStorage.getItem(
        `familyDisplayName:${normalizedEmail}`
      ) || ""
  };
}

/* ------------------------------
   LOGIN / ACCESS
------------------------------ */

async function claimApprovedEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();

  const { data, error } = await sb.rpc(
    "claim_family_email",
    { check_email: normalizedEmail }
  );

  if (error) {
    console.error(error);
    return false;
  }

  return data === true;
}

async function openAppForEmail(email, session) {
  currentUser = session.user;
  profile = buildProfile(email);

  saveAccessEmail(email);

  els.login.hidden = true;
  els.app.hidden = false;
  els.loginMsg.textContent = "";

  if (!profile.display_name) {
    els.nameDialog.showModal();
  }

  await loadEvents();
  subscribeRealtime();
}

async function restoreExistingAccess(session) {
  if (!session) {
    return false;
  }

  /*
    First try the email we saved after a previous
    approved-email login.
  */
  let email = getSavedEmail();

  /*
    Compatibility with people who were previously
    signed in using the old email-code system.
  */
  if (!email && session.user?.email) {
    email = session.user.email.trim().toLowerCase();
  }

  if (!email) {
    return false;
  }

  const allowed = await claimApprovedEmail(email);

  if (!allowed) {
    clearAccessEmail();
    return false;
  }

  await openAppForEmail(email, session);
  return true;
}

async function showLogin() {
  currentUser = null;
  profile = null;
  allEvents = [];

  els.app.hidden = true;
  els.login.hidden = false;
  els.loginMsg.textContent = "";

  if (realtimeChannel) {
    await sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

els.loginForm.onsubmit = async event => {
  event.preventDefault();

  const email = els.email.value
    .trim()
    .toLowerCase();

  if (!email) {
    return;
  }

  els.loginMsg.textContent =
    "Checking access…";

  /*
    Use an existing Supabase session if there is one.
    Otherwise create an anonymous authenticated session.
  */
  let { data: sessionData } =
    await sb.auth.getSession();

  let session = sessionData.session;

  if (!session) {
    const {
      data,
      error
    } = await sb.auth.signInAnonymously();

    if (error) {
      console.error(error);
      els.loginMsg.textContent =
        "Unable to open the schedule. Please try again.";
      return;
    }

    session = data.session;
  }

  if (!session) {
    els.loginMsg.textContent =
      "Unable to open the schedule. Please try again.";
    return;
  }

  const allowed =
    await claimApprovedEmail(email);

  if (!allowed) {
    clearAccessEmail();

    /*
      Remove the anonymous session created for an
      unapproved address.
    */
    if (session.user?.is_anonymous) {
      await sb.auth.signOut();
    }

    els.loginMsg.textContent =
      "This email does not have access to the schedule.";
    return;
  }

  await openAppForEmail(email, session);
};

els.signOut.onclick = async () => {
  clearAccessEmail();

  if (profile?.email) {
    /*
      Keep the saved display name on the device.
      Only access credentials are cleared.
    */
  }

  await sb.auth.signOut();

  els.email.value = "";
  await showLogin();
};

/* ------------------------------
   VIEWS / EVENTS
------------------------------ */

function setView(view) {
  currentView = view;

  $$("[data-view]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.view === view
    );
  });

  const headings = {
    upcoming: [
      "Upcoming",
      "Appointments and errands for Mimi and Grandaddy."
    ],
    needs: [
      "Needs Driver",
      "Upcoming events that still need transportation."
    ],
    mine: [
      "My Rides",
      "Transportation you have signed up to provide."
    ],
    all: [
      "All Events",
      "Upcoming and past events."
    ]
  };

  els.viewTitle.textContent =
    headings[view][0];

  els.viewHelp.textContent =
    headings[view][1];

  render();
}

function eventIsMine(event) {
  if (!profile) {
    return false;
  }

  /*
    New system: email is the cross-device identity.
    Old system fallback: original Supabase user ID.
  */
  return (
    (
      event.driver_email &&
      event.driver_email.toLowerCase() ===
        profile.email.toLowerCase()
    ) ||
    event.driver_user_id === currentUser?.id
  );
}

function visibleEvents() {
  const sorted = [...allEvents].sort(
    (a, b) => toDate(a) - toDate(b)
  );

  if (currentView === "upcoming") {
    return sorted.filter(event => !isPast(event));
  }

  if (currentView === "needs") {
    return sorted.filter(
      event =>
        !isPast(event) &&
        !isCovered(event)
    );
  }

  if (currentView === "mine") {
    return sorted.filter(
      event =>
        !isPast(event) &&
        eventIsMine(event)
    );
  }

  return sorted;
}

function cardHtml(event) {
  const cardClass =
    event.person === "Mimi"
      ? "mimi"
      : "grandaddy";

  let status;

  if (event.agency_covered) {
    status =
      `<strong class="covered">
        ${agencyStatus(event)}
      </strong>`;
  } else if (
    event.driver_user_id ||
    event.driver_email
  ) {
    status =
      `<strong class="covered">
        ✓ ${esc(event.driver_name || "Ride covered")} is driving
      </strong>`;
  } else {
    status =
      `<strong class="needed-text">
        DRIVER NEEDED
      </strong>`;
  }

  const actions =
    !isCovered(event) && !isPast(event)
      ? `
        <button
          type="button"
          data-claim="${event.id}">
          I can drive
        </button>

        <button
          type="button"
          class="secondary"
          data-agency="${event.id}">
          Agency
        </button>
      `
      : "";

  return `
    <article class="card ${cardClass}">
      <div class="top">
        <span class="person">
          ${esc(event.person)}
        </span>

        <span class="when">
          ${formatDate(event.event_date)}
          ·
          ${formatTime(event.event_time)}
        </span>
      </div>

      <h3>${esc(event.title)}</h3>

      ${
        event.pickup_time
          ? `
            <p class="location">
              🚗 Pickup / leave:
              ${formatTime(event.pickup_time)}
            </p>
          `
          : ""
      }

      ${
        event.location
          ? `
            <p class="location">
              ${esc(event.location)}
            </p>
          `
          : ""
      }

      <div class="ride">
        ${status}

        <div class="card-actions">
          ${actions}

          <button
            type="button"
            class="secondary"
            data-open="${event.id}">
            Details
          </button>
        </div>
      </div>
    </article>
  `;
}

function render() {
  const needsDriver =
    allEvents.filter(
      event =>
        !isPast(event) &&
        !isCovered(event)
    );

  els.needsBanner.hidden =
    !needsDriver.length;

  els.needsText.textContent =
    `${needsDriver.length} ${
      needsDriver.length === 1
        ? "ride needs"
        : "rides need"
    } drivers`;

  const list = visibleEvents();

  els.events.innerHTML =
    list.map(cardHtml).join("");

  els.empty.hidden =
    Boolean(list.length);

  $$("[data-open]").forEach(button => {
    button.onclick = () =>
      openDetails(button.dataset.open);
  });

  $$("[data-claim]").forEach(button => {
    button.onclick = () =>
      claimRide(button.dataset.claim);
  });

  $$("[data-agency]").forEach(button => {
    button.onclick = () =>
      openAgencyDialog(
        button.dataset.agency
      );
  });
}

async function loadEvents() {
  const { data, error } = await sb
    .from("events")
    .select("*")
    .order("event_date", {
      ascending: true
    })
    .order("event_time", {
      ascending: true
    });

  if (error) {
    console.error(error);
    showToast(error.message);
    return;
  }

  allEvents = data || [];
  render();
}

function subscribeRealtime() {
  if (realtimeChannel) {
    return;
  }

  realtimeChannel = sb
    .channel("events-changes")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "events"
      },
      loadEvents
    )
    .subscribe();
}

els.needsBanner.onclick =
  () => setView("needs");

$$("[data-view]").forEach(button => {
  button.onclick =
    () => setView(button.dataset.view);
});

/* ------------------------------
   ADD / EDIT EVENTS
------------------------------ */

function openNewEvent() {
  els.eventHeading.textContent =
    "Add Event";

  els.eventForm.reset();
  els.eventId.value = "";
  els.person.value = "Mimi";

  els.date.value =
    new Date()
      .toISOString()
      .slice(0, 10);

  els.deleteBtn.hidden = true;
  els.eventDialog.showModal();
}

els.addBtn.onclick = openNewEvent;
els.mobileAdd.onclick = openNewEvent;
els.closeEvent.onclick = closeEventDialog;
els.cancelEvent.onclick = closeEventDialog;

els.eventForm.onsubmit =
  async event => {
    event.preventDefault();

    const payload = {
      person: els.person.value,
      title: els.title.value.trim(),
      event_date: els.date.value,
      event_time: els.time.value,

      pickup_time:
        els.pickupTime.value || null,

      location:
        els.location.value.trim() || null,

      notes:
        els.notes.value.trim() || null,

      updated_at:
        new Date().toISOString()
    };

    let response;

    if (els.eventId.value) {
      response = await sb
        .from("events")
        .update(payload)
        .eq("id", els.eventId.value);
    } else {
      response = await sb
        .from("events")
        .insert({
          ...payload,
          created_by: currentUser.id,
          agency_covered: false,
          agency_name: null
        });
    }

    if (response.error) {
      showToast(response.error.message);
      return;
    }

    closeEventDialog();
    showToast("Saved.");
    await loadEvents();
  };

/* ------------------------------
   EVENT DETAILS
------------------------------ */

async function openDetails(id) {
  selectedEvent =
    allEvents.find(
      event => event.id === id
    );

  if (!selectedEvent) {
    return;
  }

  els.detailPerson.textContent =
    selectedEvent.person;

  els.detailTitle.textContent =
    selectedEvent.title;

  els.detailBody.innerHTML = `
    <p>
      📅 ${formatDate(selectedEvent.event_date)}
    </p>

    <p>
      🕐 Appointment:
      ${formatTime(selectedEvent.event_time)}
    </p>

    ${
      selectedEvent.pickup_time
        ? `
          <p>
            🚗 Pickup / leave:
            ${formatTime(selectedEvent.pickup_time)}
          </p>
        `
        : ""
    }

    ${
      selectedEvent.location
        ? `
          <p>
            📍 ${esc(selectedEvent.location)}
          </p>
        `
        : ""
    }

    ${
      selectedEvent.notes
        ? `
          <p>
            📝 ${esc(selectedEvent.notes)}
          </p>
        `
        : ""
    }
  `;

  if (selectedEvent.agency_covered) {
    els.driverBox.innerHTML = `
      <p>
        <strong>
          ${agencyStatus(selectedEvent)}
        </strong>
      </p>

      <button
        id="removeAgencyBtn"
        type="button"
        class="secondary">
        Agency is no longer covering this ride
      </button>
    `;

    $("#removeAgencyBtn").onclick =
      () => unmarkAgency(
        selectedEvent.id
      );
  } else if (
    selectedEvent.driver_user_id ||
    selectedEvent.driver_email
  ) {
    const mine =
      eventIsMine(selectedEvent);

    els.driverBox.innerHTML = `
      <p>
        <strong>
          ✓ ${esc(
            selectedEvent.driver_name ||
            "Someone"
          )} is driving
        </strong>
      </p>

      ${
        mine
          ? `
            <button
              id="unclaimBtn"
              type="button"
              class="secondary">
              I can't drive anymore
            </button>
          `
          : ""
      }
    `;

    if (mine) {
      $("#unclaimBtn").onclick =
        () => unclaimRide(
          selectedEvent.id
        );
    }
  } else {
    els.driverBox.innerHTML = `
      <p>
        <strong>
          DRIVER NEEDED
        </strong>
      </p>

      ${
        !isPast(selectedEvent)
          ? `
            <button
              id="claimDetailBtn"
              type="button">
              I can drive
            </button>

            <button
              id="agencyDetailBtn"
              type="button"
              class="secondary">
              Agency
            </button>
          `
          : ""
      }
    `;

    if (!isPast(selectedEvent)) {
      $("#claimDetailBtn").onclick =
        () => claimRide(
          selectedEvent.id
        );

      $("#agencyDetailBtn").onclick =
        () => openAgencyDialog(
          selectedEvent.id
        );
    }
  }

  els.detailDialog.showModal();
}

els.closeDetail.onclick =
  () => els.detailDialog.close();

/* ------------------------------
   FAMILY DRIVER
------------------------------ */

async function claimRide(id) {
  if (!profile?.display_name) {
    els.nameDialog.showModal();
    return;
  }

  const {
    data,
    error
  } = await sb
    .from("events")
    .update({
      driver_user_id: currentUser.id,
      driver_email: profile.email,
      driver_name: profile.display_name,

      agency_covered: false,
      agency_name: null,

      updated_at:
        new Date().toISOString()
    })
    .eq("id", id)
    .is("driver_user_id", null)
    .is("driver_email", null)
    .eq("agency_covered", false)
    .select()
    .maybeSingle();

  if (error) {
    showToast(error.message);
    return;
  }

  if (!data) {
    showToast(
      "This ride was just covered by someone else."
    );
    return;
  }

  if (els.detailDialog.open) {
    els.detailDialog.close();
  }

  showToast("Thank you!");
  await loadEvents();
}

async function unclaimRide(id) {
  /*
    New rides can be released from any device
    using the same approved email address.
  */
  let response = await sb
    .from("events")
    .update({
      driver_user_id: null,
      driver_email: null,
      driver_name: null,

      updated_at:
        new Date().toISOString()
    })
    .eq("id", id)
    .eq("driver_email", profile.email);

  /*
    Compatibility for rides claimed before
    driver_email was added.
  */
  if (
    !response.error &&
    response.count === 0
  ) {
    response = await sb
      .from("events")
      .update({
        driver_user_id: null,
        driver_email: null,
        driver_name: null,

        updated_at:
          new Date().toISOString()
      })
      .eq("id", id)
      .eq(
        "driver_user_id",
        currentUser.id
      );
  }

  if (response.error) {
    showToast(response.error.message);
    return;
  }

  if (els.detailDialog.open) {
    els.detailDialog.close();
  }

  showToast("Ride released.");
  await loadEvents();
}

/* ------------------------------
   AGENCY TRANSPORTATION
------------------------------ */

function openAgencyDialog(id) {
  pendingAgencyEventId = id;
  els.agencyName.value = "";

  if (els.detailDialog.open) {
    els.detailDialog.close();
  }

  els.agencyDialog.showModal();
  els.agencyName.focus();
}

els.closeAgency.onclick = () => {
  pendingAgencyEventId = null;
  els.agencyDialog.close();
};

els.cancelAgency.onclick = () => {
  pendingAgencyEventId = null;
  els.agencyDialog.close();
};

els.agencyForm.onsubmit =
  async event => {
    event.preventDefault();

    if (!pendingAgencyEventId) {
      return;
    }

    const id =
      pendingAgencyEventId;

    const name =
      els.agencyName.value.trim() ||
      null;

    const {
      data,
      error
    } = await sb
      .from("events")
      .update({
        agency_covered: true,
        agency_name: name,

        driver_user_id: null,
        driver_email: null,
        driver_name: null,

        updated_at:
          new Date().toISOString()
      })
      .eq("id", id)
      .is("driver_user_id", null)
      .is("driver_email", null)
      .eq("agency_covered", false)
      .select()
      .maybeSingle();

    if (error) {
      showToast(error.message);
      return;
    }

    if (!data) {
      showToast(
        "This ride was just covered by someone else."
      );
      return;
    }

    pendingAgencyEventId = null;

    els.agencyDialog.close();

    showToast(
      "Agency transportation noted."
    );

    await loadEvents();
  };

async function unmarkAgency(id) {
  const { error } = await sb
    .from("events")
    .update({
      agency_covered: false,
      agency_name: null,

      updated_at:
        new Date().toISOString()
    })
    .eq("id", id)
    .eq("agency_covered", true);

  if (error) {
    showToast(error.message);
    return;
  }

  if (els.detailDialog.open) {
    els.detailDialog.close();
  }

  showToast(
    "Agency coverage removed."
  );

  await loadEvents();
}

/* ------------------------------
   EDIT / DELETE
------------------------------ */

els.editBtn.onclick = () => {
  if (!selectedEvent) {
    return;
  }

  els.detailDialog.close();

  els.eventHeading.textContent =
    "Edit Event";

  els.eventId.value =
    selectedEvent.id;

  els.person.value =
    selectedEvent.person;

  els.title.value =
    selectedEvent.title;

  els.date.value =
    selectedEvent.event_date;

  els.time.value =
    (selectedEvent.event_time || "")
      .slice(0, 5);

  els.pickupTime.value =
    (selectedEvent.pickup_time || "")
      .slice(0, 5);

  els.location.value =
    selectedEvent.location || "";

  els.notes.value =
    selectedEvent.notes || "";

  els.deleteBtn.hidden = false;

  els.eventDialog.showModal();
};

els.deleteBtn.onclick =
  async () => {
    if (!els.eventId.value) {
      return;
    }

    if (
      !confirm(
        "Delete this event?"
      )
    ) {
      return;
    }

    const { error } = await sb
      .from("events")
      .delete()
      .eq(
        "id",
        els.eventId.value
      );

    if (error) {
      showToast(error.message);
      return;
    }

    closeEventDialog();

    showToast("Deleted.");

    await loadEvents();
  };

/* ------------------------------
   DISPLAY NAME
------------------------------ */

els.nameForm.onsubmit = event => {
  event.preventDefault();

  const name =
    els.displayName.value.trim();

  if (!name || !profile) {
    return;
  }

  profile.display_name = name;

  localStorage.setItem(
    `familyDisplayName:${profile.email}`,
    name
  );

  els.nameDialog.close();

  showToast("Saved.");
};

/* ------------------------------
   ADD TO CALENDAR
------------------------------ */

function icsEscape(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsLocalDateTime(
  date,
  time
) {
  const pad = number =>
    String(number).padStart(2, "0");

  const parts =
    String(
      time || "00:00:00"
    ).split(":");

  const h =
    Number(parts[0] || 0);

  const m =
    Number(parts[1] || 0);

  const s =
    Number(parts[2] || 0);

  return (
    date.replaceAll("-", "") +
    "T" +
    pad(h) +
    pad(m) +
    pad(s)
  );
}

function icsDateFromJS(date) {
  const pad = number =>
    String(number).padStart(2, "0");

  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `T` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`
  );
}

els.calendarBtn.onclick =
  async () => {
    if (!selectedEvent) {
      return;
    }

    const start =
      icsLocalDateTime(
        selectedEvent.event_date,
        selectedEvent.event_time
      );

    const endDate =
      new Date(
        toDate(selectedEvent)
          .getTime() +
        60 * 60 * 1000
      );

    const end =
      icsDateFromJS(endDate);

    const description = [
      selectedEvent.pickup_time
        ? `Pickup / leave: ${formatTime(
            selectedEvent.pickup_time
          )}`
        : "",

      selectedEvent.notes || ""
    ]
      .filter(Boolean)
      .join("\n");

    const dtstamp =
      new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Mimi and Grandaddy Transportation//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",

      `UID:${selectedEvent.id}@mimi-grandaddy-transportation`,

      `DTSTAMP:${dtstamp}`,

      `DTSTART:${start}`,

      `DTEND:${end}`,

      `SUMMARY:${icsEscape(
        `${selectedEvent.person}: ${selectedEvent.title}`
      )}`
    ];

    if (selectedEvent.location) {
      lines.push(
        `LOCATION:${icsEscape(
          selectedEvent.location
        )}`
      );
    }

    if (description) {
      lines.push(
        `DESCRIPTION:${icsEscape(
          description
        )}`
      );
    }

    lines.push(
      "END:VEVENT",
      "END:VCALENDAR"
    );

    const body =
      lines.join("\r\n") +
      "\r\n";

    const fileName =
      `${selectedEvent.person}-${selectedEvent.event_date}.ics`;

    const file = new File(
      [body],
      fileName,
      {
        type:
          "text/calendar;charset=utf-8"
      }
    );

    try {
      if (
        navigator.share &&
        navigator.canShare &&
        navigator.canShare({
          files: [file]
        })
      ) {
        await navigator.share({
          files: [file],
          title:
            `${selectedEvent.person}: ${selectedEvent.title}`
        });

        return;
      }
    } catch (error) {
      if (
        error?.name ===
        "AbortError"
      ) {
        return;
      }
    }

    const url =
      URL.createObjectURL(file);

    const link =
      document.createElement("a");

    link.href = url;
    link.download = fileName;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(
      () =>
        URL.revokeObjectURL(url),
      1000
    );
  };

/* ------------------------------
   STARTUP
------------------------------ */

async function start() {
  const {
    data: { session }
  } = await sb.auth.getSession();

  /*
    If this browser already has a saved approved
    email/session, open the schedule automatically.
  */
  if (session) {
    const restored =
      await restoreExistingAccess(
        session
      );

    if (restored) {
      return;
    }
  }

  await showLogin();
}

sb.auth.onAuthStateChange(
  async (event, session) => {
    /*
      SIGNED_OUT is handled here.
      Other session refreshes do not need to reopen
      dialogs or reload the entire app.
    */
    if (
      event === "SIGNED_OUT"
    ) {
      await showLogin();
    }
  }
);

await start();
