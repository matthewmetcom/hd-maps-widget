// ─── Field API name mapping ──────────────────────────────────────────────
// If any of these differ from the real Zoho API names, fix them here only.
var FIELDS = {
  address:  'Location',
  geo:      'Geo_Location',
  timezone: 'Timezone',
  placeId:  'Place_ID',
  start:    'Start_Location',
  finish:   'Finish_Location',
};

var TZ_FUNCTION = 'hd_get_timezone';

var currentModule   = null;
var currentEntityId = null;
var mapsReady = false;

// Picked places held in memory — nothing is written until "Apply".
var primaryPlace = null, startPlace = null, finishPlace = null;

var statusEl = document.getElementById('status');
var applyBtn = document.getElementById('applyBtn');
var cancelBtn = document.getElementById('cancelBtn');

function setStatus(msg, cls) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

// ─── Boot ─────────────────────────────────────────────────────────────────
ZOHO.embeddedApp.on('PageLoad', function (data) {
  console.log('[HDMaps] PageLoad:', data);
  currentModule = data && data.Entity ? data.Entity : null;
  if (data && data.EntityId) {
    currentEntityId = Array.isArray(data.EntityId) ? data.EntityId[0] : data.EntityId;
  }
  console.log('[HDMaps] module=', currentModule, 'entityId=', currentEntityId);

  // Dump the real field API names so we can confirm the mapping.
  if (ZOHO.CRM.META && ZOHO.CRM.META.getFields) {
    ZOHO.CRM.META.getFields({ Entity: currentModule }).then(function (r) {
      var fs = (r && r.fields) || [];
      var relevant = fs
        .filter(function (f) { return /location|geo|time|place/i.test(f.api_name || ''); })
        .map(function (f) { return f.api_name; });
      console.log('[HDMaps] relevant field API names:', relevant);
    }).catch(function (e) { console.log('[HDMaps] getFields failed:', e); });
  }

  // Show start/finish only on the Event module.
  if (currentModule && /event/i.test(currentModule)) {
    document.getElementById('startField').classList.remove('hidden');
    document.getElementById('finishField').classList.remove('hidden');
  }
  tryWireAutocomplete();
});

ZOHO.embeddedApp.init();

// ─── Google Maps callback ─────────────────────────────────────────────────
window.__initMaps = function () { mapsReady = true; tryWireAutocomplete(); };

function tryWireAutocomplete() {
  if (!mapsReady || typeof google === 'undefined') return;
  wireBox('primaryInput', function (p) { primaryPlace = p; onPicked(); });
  if (currentModule && /event/i.test(currentModule)) {
    wireBox('startInput',  function (p) { startPlace = p;  onPicked(); });
    wireBox('finishInput', function (p) { finishPlace = p; onPicked(); });
  }
  setStatus('Start typing an address…', 'busy');
}

function wireBox(inputId, handler) {
  var input = document.getElementById(inputId);
  if (!input || input.__wired) return;
  input.__wired = true;
  var ac = new google.maps.places.Autocomplete(input, {
    fields: ['name', 'formatted_address', 'geometry', 'place_id'],
  });
  ac.addListener('place_changed', function () {
    var place = ac.getPlace();
    if (!place || !place.geometry) {
      setStatus('Pick an address from the dropdown list.', 'err');
      return;
    }
    handler(place);
  });
}

function onPicked() {
  applyBtn.disabled = false;
  setStatus('Address selected — click “Apply Address” to fill the form.', 'busy');
}

// ─── Apply button: write everything, then close ───────────────────────────
applyBtn.addEventListener('click', function () {
  if (!primaryPlace && !startPlace && !finishPlace) return;

  var record = {};
  var lat = null, lng = null;
  if (primaryPlace) {
    lat = primaryPlace.geometry.location.lat();
    lng = primaryPlace.geometry.location.lng();
    record[FIELDS.address] = displayAddress(primaryPlace);
    record[FIELDS.geo]     = lat + ',' + lng;
    record[FIELDS.placeId] = primaryPlace.place_id;
  }
  if (startPlace)  record[FIELDS.start]  = displayAddress(startPlace);
  if (finishPlace) record[FIELDS.finish] = displayAddress(finishPlace);

  setStatus('Applying…', 'busy');
  applyBtn.disabled = true;

  // Timezone is computed offline from the coordinates — instant, no API call.
  if (lat !== null) {
    var tz = getTimezone(lat, lng);
    if (tz) record[FIELDS.timezone] = tz;
    console.log('[HDMaps] timezone =', tz);
  }

  populate(record).then(function () {
    setStatus('✓ Applied to the form. Closing…', 'ok');
    setTimeout(closePopup, 700);
  }).catch(function (err) {
    console.error('[HDMaps] apply error:', err);
    setStatus('Write failed — see console (F12).', 'err');
    applyBtn.disabled = false;
  });
});

cancelBtn.addEventListener('click', closePopup);

// ─── Write to record / form ───────────────────────────────────────────────
function populate(record) {
  console.log('[HDMaps] writing:', record, 'entityId=', currentEntityId);
  if (currentEntityId) {
    var apiData = Object.assign({ id: currentEntityId }, record);
    return ZOHO.CRM.API.updateRecord({ Entity: currentModule, APIData: apiData, Trigger: [] })
      .then(function (r) { console.log('[HDMaps] updateRecord resp:', r); return r; });
  }
  return ZOHO.CRM.UI.Record.populate(record)
    .then(function (r) { console.log('[HDMaps] populate resp:', r); return r; });
}

// ─── Build the display address, prepending the venue name if it's a place ─
// For a named venue Google returns name="The Como Pub" separately from the
// street address. For a plain address pick, name is just the street part —
// so we only prepend it when it isn't already inside the formatted address.
function displayAddress(place) {
  var name = (place.name || '').trim();
  var addr = (place.formatted_address || '').trim();
  if (name && addr && addr.indexOf(name) === -1) {
    return name + ', ' + addr;
  }
  return addr || name;
}

// ─── Timezone — offline lookup from coordinates (tz.js) ──────────────────
function getTimezone(lat, lng) {
  try {
    if (typeof tzlookup === 'function') return tzlookup(lat, lng);
    console.warn('[HDMaps] tzlookup not loaded');
    return null;
  } catch (e) {
    console.error('[HDMaps] tzlookup error:', e);
    return null;
  }
}

function closePopup() {
  try {
    // Existing record → reload so the updated fields show immediately.
    // New create form → plain close so the in-progress form is preserved.
    if (currentEntityId && ZOHO.CRM.UI.Popup.closeReload) {
      ZOHO.CRM.UI.Popup.closeReload();
    } else {
      ZOHO.CRM.UI.Popup.close();
    }
  } catch (e) { console.log('[HDMaps] popup close not available:', e); }
}
