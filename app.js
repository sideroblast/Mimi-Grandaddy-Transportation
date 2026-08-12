import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

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

function esc(v = "") {
  return String(v).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 2500);
}

function toDate(e) {
  return new Date(`${e.event_date}T${e.event_time || "00:00"}:00`);
}

function isPast(e) { return toDate(e) < new Date(); }

function formatDate(d) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })
    .format(new Date(`${d}T12:00:00`));
}

function formatTime(t) {
  const [h, m] = (t || "00:00").split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(2000, 0, 1, h, m));
}

function setView(view) {
  currentView = view;
  $$('[data-view]').forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const meta = {
    upcoming: ["Upcoming", "Appointments and errands for Mimi and Grandaddy."],
    needs: ["Needs Driver", "Upcoming events that still need transportation."],
    mine: ["My Rides", "Transportation you have signed up to provide."],
    all: ["All Events", "Upcoming and past events."]
  };
  els.viewTitle.textContent = meta[view][0];
  els.viewHelp.textContent = meta[view][1];
  render();
}

function visibleEvents() {
  const sorted = [...allEvents].sort((a, b) => toDate(a) - toDate(b));
  if (currentView === "upcoming") return sorted.filter((e) => !isPast(e));
  if (currentView === "needs") return sorted.filter((e) => !isPast(e) && !e.driver_user_id);
  if (currentView === "mine") return sorted.filter((e) => !isPast(e) && e.driver_user_id === currentUser?.id);
  return sorted;
}

function cardHtml(e) {
  const cls = e.person === "Mimi" ? "mimi" : "grandaddy";
  const status = e.driver_user_id
    ? `<strong class="covered">✓ ${esc(e.driver_name || "Ride covered")} is driving</strong>`
    : `<strong class="needed">DRIVER NEEDED</strong>`;
  const claim = !e.driver_user_id && !isPast(e)
    ? `<button type="button" data-claim="${e.id}">I can drive</button>` : "";
  return `<article class="event-card ${cls}">
    <div><span class="person">${esc(e.person)}</span><span class="when">${formatDate(e.event_date)} · ${formatTime(e.event_time)}</span></div>
    <h3>${esc(e.title)}</h3>
    ${e.location ? `<p class="muted">${esc(e.location)}</p>` : ""}
    <div class="ride-row">${status}<div>${claim}<button type="button" class="secondary" data-open="${e.id}">Details</button></div></div>
  </article>`;
}

function render() {
  const needs = allEvents.filter((e) => !isPast(e) && !e.driver_user_id);
  els.needsBanner.hidden = needs.length === 0;
  els.needsText.textContent = `${needs.length} ${needs.length === 1 ? "ride needs" : "rides need"} drivers`;

  const list = visibleEvents();
  els.events.innerHTML = list.map(cardHtml).join("");
  els.empty.hidden = list.length > 0;

  $$('[data-open]').forEach((b) => b.addEventListener("click", () => openDetails(b.dataset.open)));
  $$('[data-claim]').forEach((b) => b.addEventListener("click", () => claimRide(b.dataset.claim)));
}

async function loadEvents() {
  const { data, error } = await sb.from("events").select("*")
    .order("event_date", { ascending: true })
    .order("event_time", { ascending: true });
  if (error) return showToast(error.message);
  allEvents = data || [];
  render();
}

function subscribeRealtime() {
  if (realtimeChannel) return;
  realtimeChannel = sb.channel("events-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, loadEvents)
    .subscribe();
}

async function handleSession(session) {
  if (!session) {
    currentUser = null;
    profile = null;
    allEvents = [];
    els.login.hidden = false;
    els.app.hidden = true;
    if (realtimeChannel) {
      await sb.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    return;
  }

  currentUser = session.user;
  const email = currentUser.email.trim().toLowerCase();

  const { data: allowed, error: inviteError } = await sb.rpc("is_invited_email", { check_email: email });
  if (inviteError || !allowed) {
    await sb.auth.signOut();
    els.loginMsg.textContent = "This email is not on the family access list.";
    return;
  }

  const { data: member, error } = await sb.from("family_members")
    .select("email,display_name")
    .ilike("email", email)
    .maybeSingle();

  if (error || !member) {
    await sb.auth.signOut();
    els.loginMsg.textContent = "This email is not on the family access list.";
    return;
  }

  profile = member;
  els.login.hidden = true;
  els.app.hidden = false;
  if (!profile.display_name) els.nameDialog.showModal();
  await loadEvents();
  subscribeRealtime();
}

els.loginForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = els.email.value.trim().toLowerCase();
  els.loginMsg.textContent = "Checking family access…";

  const { data: allowed, error: inviteError } = await sb.rpc("is_invited_email", { check_email: email });
  if (inviteError) {
    els.loginMsg.textContent = "Unable to check family access. Please try again.";
    return;
  }
  if (!allowed) {
    els.loginMsg.textContent = "That email is not on the family access list.";
    return;
  }

  els.loginMsg.textContent = "Sending sign-in link…";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href, shouldCreateUser: true }
  });
  els.loginMsg.textContent = error ? error.message : "Check your email and tap the sign-in link.";
});

els.signOut.addEventListener("click", () => sb.auth.signOut());
els.needsBanner.addEventListener("click", () => setView("needs"));
$$('[data-view]').forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

function openNewEvent() {
  els.eventHeading.textContent = "Add Event";
  els.eventForm.reset();
  els.eventId.value = "";
  els.person.value = "Mimi";
  els.date.value = new Date().toISOString().slice(0, 10);
  els.deleteBtn.hidden = true;
  els.eventDialog.showModal();
}

els.addBtn.addEventListener("click", openNewEvent);
els.mobileAdd.addEventListener("click", openNewEvent);
els.closeEvent.addEventListener("click", () => els.eventDialog.close());
els.cancelEvent.addEventListener("click", () => els.eventDialog.close());

els.eventForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const payload = {
    person: els.person.value,
    title: els.title.value.trim(),
    event_date: els.date.value,
    event_time: els.time.value,
    location: els.location.value.trim() || null,
    notes: els.notes.value.trim() || null,
    updated_at: new Date().toISOString()
  };

  const result = els.eventId.value
    ? await sb.from("events").update(payload).eq("id", els.eventId.value)
    : await sb.from("events").insert({ ...payload, created_by: currentUser.id });

  if (result.error) return showToast(result.error.message);
  els.eventDialog.close();
  showToast("Saved.");
  await loadEvents();
});

async function openDetails(id) {
  selectedEvent = allEvents.find((e) => e.id === id);
  if (!selectedEvent) return;

  els.detailPerson.textContent = selectedEvent.person;
  els.detailTitle.textContent = selectedEvent.title;
  els.detailBody.innerHTML = `
    <p>📅 ${formatDate(selectedEvent.event_date)}</p>
    <p>🕐 ${formatTime(selectedEvent.event_time)}</p>
    ${selectedEvent.location ? `<p>📍 ${esc(selectedEvent.location)}</p>` : ""}
    ${selectedEvent.notes ? `<p>📝 ${esc(selectedEvent.notes)}</p>` : ""}`;

  if (selectedEvent.driver_user_id) {
    const mine = selectedEvent.driver_user_id === currentUser.id;
    els.driverBox.innerHTML = `<p><strong>✓ ${esc(selectedEvent.driver_name || "Someone")} is driving</strong></p>${mine ? '<button id="unclaimBtn" type="button" class="secondary">I can\'t drive anymore</button>' : ""}`;
    $("#unclaimBtn")?.addEventListener("click", () => unclaimRide(selectedEvent.id));
  } else {
    els.driverBox.innerHTML = `<p><strong>DRIVER NEEDED</strong></p>${!isPast(selectedEvent) ? '<button id="claimDetailBtn" type="button">I can drive</button>' : ""}`;
    $("#claimDetailBtn")?.addEventListener("click", () => claimRide(selectedEvent.id));
  }

  els.detailDialog.showModal();
}

els.closeDetail.addEventListener("click", () => els.detailDialog.close());

async function claimRide(id) {
  if (!profile?.display_name) {
    els.nameDialog.showModal();
    return;
  }
  const { data, error } = await sb.from("events")
    .update({ driver_user_id: currentUser.id, driver_name: profile.display_name, updated_at: new Date().toISOString() })
    .eq("id", id).is("driver_user_id", null).select().maybeSingle();
  if (error) return showToast(error.message);
  if (!data) return showToast("Someone else just claimed this ride.");
  els.detailDialog.close();
  showToast("Thank you!");
  await loadEvents();
}

async function unclaimRide(id) {
  const { error } = await sb.from("events")
    .update({ driver_user_id: null, driver_name: null, updated_at: new Date().toISOString() })
    .eq("id", id).eq("driver_user_id", currentUser.id);
  if (error) return showToast(error.message);
  els.detailDialog.close();
  showToast("Ride released.");
  await loadEvents();
}

els.editBtn.addEventListener("click", () => {
  if (!selectedEvent) return;
  els.detailDialog.close();
  els.eventHeading.textContent = "Edit Event";
  els.eventId.value = selectedEvent.id;
  els.person.value = selectedEvent.person;
  els.title.value = selectedEvent.title;
  els.date.value = selectedEvent.event_date;
  els.time.value = (selectedEvent.event_time || "").slice(0, 5);
  els.location.value = selectedEvent.location || "";
  els.notes.value = selectedEvent.notes || "";
  els.deleteBtn.hidden = false;
  els.eventDialog.showModal();
});

els.deleteBtn.addEventListener("click", async () => {
  if (!els.eventId.value || !confirm("Delete this event?")) return;
  const { error } = await sb.from("events").delete().eq("id", els.eventId.value);
  if (error) return showToast(error.message);
  els.eventDialog.close();
  showToast("Deleted.");
  await loadEvents();
});

els.nameForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = els.displayName.value.trim();
  if (!name) return;
  const { error } = await sb.from("family_members")
    .update({ display_name: name })
    .ilike("email", currentUser.email.trim().toLowerCase());
  if (error) return showToast(error.message);
  profile.display_name = name;
  els.nameDialog.close();
  showToast("Saved.");
});

els.calendarBtn.addEventListener("click", () => {
  if (!selectedEvent) return;
  const start = `${selectedEvent.event_date.replaceAll("-", "")}T${(selectedEvent.event_time || "00:00").replace(":", "")}00`;
  const endDate = new Date(toDate(selectedEvent).getTime() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const end = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}T${pad(endDate.getHours())}${pad(endDate.getMinutes())}00`;
  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Family Transportation//EN", "BEGIN:VEVENT",
    `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${selectedEvent.person}: ${selectedEvent.title}`,
    `LOCATION:${selectedEvent.location || ""}`, `DESCRIPTION:${(selectedEvent.notes || "").replace(/\n/g, "\\n")}`,
    "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
  a.download = `${selectedEvent.person}-${selectedEvent.event_date}.ics`;
  a.click();
  URL.revokeObjectURL(a.href);
});

const { data } = await sb.auth.getSession();
await handleSession(data.session);
sb.auth.onAuthStateChange(async (_event, session) => handleSession(session));
