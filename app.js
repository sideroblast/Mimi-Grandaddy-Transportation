import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const els = {
  auth: $("#authScreen"), app: $("#app"), loginForm: $("#loginForm"),
  loginEmail: $("#loginEmail"), loginMessage: $("#loginMessage"), signOut: $("#signOutBtn"),
  list: $("#eventList"), empty: $("#emptyState"), banner: $("#alertBanner"), needsCount: $("#needsCount"),
  viewTitle: $("#viewTitle"), viewSubtitle: $("#viewSubtitle"), add: $("#addEventBtn"), mobileAdd: $("#mobileAddBtn"),
  eventDialog: $("#eventDialog"), detailDialog: $("#detailDialog"), nameDialog: $("#nameDialog"),
  eventForm: $("#eventForm"), eventDialogTitle: $("#eventDialogTitle"), eventId: $("#eventId"), person: $("#person"),
  title: $("#title"), date: $("#date"), time: $("#time"), location: $("#location"), notes: $("#notes"),
  deleteBtn: $("#deleteEventBtn"), detailPerson: $("#detailPerson"), detailTitle: $("#detailTitle"),
  detailBody: $("#detailBody"), driverPanel: $("#driverPanel"), editFromDetail: $("#editFromDetailBtn"),
  calendarBtn: $("#calendarBtn"), nameForm: $("#nameForm"), displayName: $("#displayName"), toast: $("#toast")
};

let currentUser = null;
let profile = null;
let events = [];
let currentView = "upcoming";
let detailEvent = null;
let realtimeChannel = null;

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function eventDate(e) { return new Date(`${e.event_date}T${e.event_time || "00:00"}:00`); }
function isPast(e) { return eventDate(e) < new Date(); }
function fmtDate(dateString) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })
    .format(new Date(`${dateString}T12:00:00`));
}
function fmtTime(timeString) {
  const [h, m] = (timeString || "00:00").split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(2000, 0, 1, h, m));
}

function setupNavigation() {
  $$("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  els.banner.addEventListener("click", () => setView("needs"));
}

function setView(view) {
  currentView = view;
  $$(".tab,.nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const meta = {
    upcoming: ["Upcoming", "Appointments and errands for Mimi and Grandaddy."],
    needs: ["Needs Driver", "Upcoming events that still need transportation."],
    mine: ["My Rides", "Transportation you have signed up to provide."],
    all: ["All Events", "Upcoming and past events."]
  };
  els.viewTitle.textContent = meta[view][0];
  els.viewSubtitle.textContent = meta[view][1];
  render();
}

function filteredEvents() {
  const sorted = [...events].sort((a, b) => eventDate(a) - eventDate(b));
  if (currentView === "upcoming") return sorted.filter((e) => !isPast(e));
  if (currentView === "needs") return sorted.filter((e) => !isPast(e) && !e.driver_user_id);
  if (currentView === "mine") return sorted.filter((e) => !isPast(e) && e.driver_user_id === currentUser?.id);
  return sorted;
}

function render() {
  const upcomingNeeds = events.filter((e) => !isPast(e) && !e.driver_user_id);
  els.banner.classList.toggle("hidden", upcomingNeeds.length === 0);
  els.needsCount.textContent = `${upcomingNeeds.length} ${upcomingNeeds.length === 1 ? "ride needs" : "rides need"} drivers`;
  const list = filteredEvents();
  els.empty.classList.toggle("hidden", list.length > 0);
  els.list.innerHTML = list.map(cardHTML).join("");
  $$("[data-open]").forEach((b) => b.addEventListener("click", () => openDetails(b.dataset.open)));
  $$("[data-claim]").forEach((b) => b.addEventListener("click", () => claimRide(b.dataset.claim)));
}

function cardHTML(e) {
  const personClass = e.person.toLowerCase();
  const status = e.driver_user_id
    ? `<span class="status covered">● ${esc(e.driver_name || "Ride covered")} is driving</span>`
    : `<span class="status needed">DRIVER NEEDED</span>`;
  const claim = !e.driver_user_id && !isPast(e)
    ? `<button class="btn claim" data-claim="${e.id}" type="button">I can drive</button>` : "";
  return `<article class="event-card ${personClass}">
    <div class="event-top"><span class="person ${personClass}">${esc(e.person)}</span><span class="when">${fmtDate(e.event_date)} · ${fmtTime(e.event_time)}</span></div>
    <div><h3>${esc(e.title)}</h3>${e.location ? `<div class="location">${esc(e.location)}</div>` : ""}</div>
    <div class="ride-row">${status}<div class="card-actions">${claim}<button class="btn ghost" data-open="${e.id}" type="button">Details</button></div></div>
  </article>`;
}

async function initialize() {
  setupNavigation();
  const { data } = await sb.auth.getSession();
  await handleSession(data.session);
  sb.auth.onAuthStateChange(async (_event, session) => handleSession(session));
}

async function handleSession(session) {
  if (!session) {
    currentUser = null; profile = null; events = [];
    els.app.classList.add("hidden"); els.auth.classList.remove("hidden");
    if (realtimeChannel) { await sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    return;
  }
  currentUser = session.user;
  const { data: member, error } = await sb.from("family_members")
    .select("email,display_name")
    .eq("email", currentUser.email.toLowerCase())
    .maybeSingle();
  if (error || !member) {
    await sb.auth.signOut();
    els.loginMessage.textContent = "This email is not on the family access list.";
    return;
  }
  profile = member;
  els.auth.classList.add("hidden"); els.app.classList.remove("hidden");
  if (!profile.display_name) els.nameDialog.showModal();
  await loadEvents();
  subscribeRealtime();
}

async function loadEvents() {
  const { data, error } = await sb.from("events").select("*")
    .order("event_date", { ascending: true }).order("event_time", { ascending: true });
  if (error) return toast(error.message);
  events = data || [];
  render();
}

function subscribeRealtime() {
  if (realtimeChannel) return;
  realtimeChannel = sb.channel("events-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, () => loadEvents())
    .subscribe();
}

els.loginForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = els.loginEmail.value.trim().toLowerCase();
  els.loginMessage.textContent = "Checking family access…";

  const { data: allowed, error: inviteError } = await sb.rpc("is_invited_email", { check_email: email });
  if (inviteError) {
    els.loginMessage.textContent = "Unable to check family access. Please try again.";
    return;
  }
  if (!allowed) {
    els.loginMessage.textContent = "That email is not on the family access list.";
    return;
  }

  els.loginMessage.textContent = "Sending sign-in link…";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href, shouldCreateUser: true }
  });
  els.loginMessage.textContent = error ? error.message : "Check your email and tap the sign-in link.";
});

els.signOut.addEventListener("click", () => sb.auth.signOut());

function newEvent() {
  els.eventDialogTitle.textContent = "Add Event";
  els.eventForm.reset();
  els.eventId.value = "";
  els.person.value = "Mimi";
  els.date.value = new Date().toISOString().slice(0, 10);
  els.deleteBtn.classList.add("hidden");
  els.eventDialog.showModal();
}

els.add.addEventListener("click", newEvent);
els.mobileAdd.addEventListener("click", newEvent);
$("#closeEventDialog").addEventListener("click", () => els.eventDialog.close());
$("#cancelEventBtn").addEventListener("click", () => els.eventDialog.close());

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
  if (result.error) return toast(result.error.message);
  els.eventDialog.close();
  toast("Saved.");
  await loadEvents();
});

async function openDetails(id) {
  detailEvent = events.find((e) => e.id === id);
  if (!detailEvent) return;
  els.detailPerson.textContent = detailEvent.person;
  els.detailPerson.style.color = detailEvent.person === "Mimi" ? "var(--purple)" : "var(--blue)";
  els.detailTitle.textContent = detailEvent.title;
  els.detailBody.innerHTML = `
    <div class="detail-line"><span>📅</span><span>${fmtDate(detailEvent.event_date)}</span></div>
    <div class="detail-line"><span>🕐</span><span>${fmtTime(detailEvent.event_time)}</span></div>
    ${detailEvent.location ? `<div class="detail-line"><span>📍</span><span>${esc(detailEvent.location)}</span></div>` : ""}
    ${detailEvent.notes ? `<div class="detail-line"><span>📝</span><span>${esc(detailEvent.notes)}</span></div>` : ""}`;
  if (detailEvent.driver_user_id) {
    const mine = detailEvent.driver_user_id === currentUser.id;
    els.driverPanel.className = "driver-panel driver-covered";
    els.driverPanel.innerHTML = `<strong>✓ ${esc(detailEvent.driver_name || "Someone")} is driving</strong>${mine ? `<button id="unclaimBtn" class="btn ghost" type="button">I can't drive anymore</button>` : ""}`;
    $("#unclaimBtn")?.addEventListener("click", () => unclaimRide(detailEvent.id));
  } else {
    els.driverPanel.className = "driver-panel driver-needed";
    els.driverPanel.innerHTML = `<strong>DRIVER NEEDED</strong>${!isPast(detailEvent) ? `<button id="claimDetailBtn" class="btn primary" type="button">I can drive</button>` : ""}`;
    $("#claimDetailBtn")?.addEventListener("click", () => claimRide(detailEvent.id));
  }
  els.detailDialog.showModal();
}

$("#closeDetailDialog").addEventListener("click", () => els.detailDialog.close());

async function claimRide(id) {
  if (!profile?.display_name) { els.nameDialog.showModal(); return; }
  const { data, error } = await sb.from("events")
    .update({ driver_user_id: currentUser.id, driver_name: profile.display_name, updated_at: new Date().toISOString() })
    .eq("id", id).is("driver_user_id", null).select().maybeSingle();
  if (error) return toast(error.message);
  if (!data) return toast("Someone else just claimed this ride.");
  els.detailDialog.close();
  toast("Thank you!");
  await loadEvents();
}

async function unclaimRide(id) {
  const { error } = await sb.from("events")
    .update({ driver_user_id: null, driver_name: null, updated_at: new Date().toISOString() })
    .eq("id", id).eq("driver_user_id", currentUser.id);
  if (error) return toast(error.message);
  els.detailDialog.close();
  toast("Ride released.");
  await loadEvents();
}

els.editFromDetail.addEventListener("click", () => {
  if (!detailEvent) return;
  els.detailDialog.close();
  els.eventDialogTitle.textContent = "Edit Event";
  els.eventId.value = detailEvent.id;
  els.person.value = detailEvent.person;
  els.title.value = detailEvent.title;
  els.date.value = detailEvent.event_date;
  els.time.value = (detailEvent.event_time || "").slice(0, 5);
  els.location.value = detailEvent.location || "";
  els.notes.value = detailEvent.notes || "";
  els.deleteBtn.classList.remove("hidden");
  els.eventDialog.showModal();
});

els.deleteBtn.addEventListener("click", async () => {
  if (!els.eventId.value || !confirm("Delete this event?")) return;
  const { error } = await sb.from("events").delete().eq("id", els.eventId.value);
  if (error) return toast(error.message);
  els.eventDialog.close();
  toast("Deleted.");
  await loadEvents();
});

els.nameForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = els.displayName.value.trim();
  if (!name) return;
  const { error } = await sb.from("family_members")
    .update({ display_name: name })
    .eq("email", currentUser.email.toLowerCase());
  if (error) return toast(error.message);
  profile.display_name = name;
  els.nameDialog.close();
  toast("Saved.");
});

els.calendarBtn.addEventListener("click", () => {
  if (!detailEvent) return;
  const start = `${detailEvent.event_date.replaceAll("-", "")}T${(detailEvent.event_time || "00:00").replace(":", "")}00`;
  const endDate = new Date(eventDate(detailEvent).getTime() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const end = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}T${pad(endDate.getHours())}${pad(endDate.getMinutes())}00`;
  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Family Transportation//EN", "BEGIN:VEVENT",
    `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${detailEvent.person}: ${detailEvent.title}`,
    `LOCATION:${detailEvent.location || ""}`, `DESCRIPTION:${(detailEvent.notes || "").replace(/\n/g, "\\n")}`,
    "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
  a.download = `${detailEvent.person}-${detailEvent.event_date}.ics`;
  a.click();
  URL.revokeObjectURL(a.href);
});

initialize();
