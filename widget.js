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

// Standalone Deluge function that returns a timezone id for lat,lng.
var TZ_FUNCTION = 'hd_get_timezone';

var currentModule   = null;   // 'Deals' or the Events module API name
var currentEntityId = null;   // record id when opened on a saved record
var mapsReady = false;

var statusEl = document.getElementById('status');
function setStatus(msg, cls) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

// ─── Boot: init the Zoho SDK, learn which module we're on ────────────────
ZOHO.embeddedApp.on('PageLoad', function (data) {
  currentModule = data && data.Entity ? data.Entity : null;
  if (data && data.EntityId) {
    currentEntityId = Array.isArray(data.EntityId) ? data.EntityId[0] : data.EntityId;
  }
  // Show start/finish boxes only on the Event module (it has those fields).
  if (currentModule && currentModule !== 'Deals') {
    document.getElementById('startField').classList.remove('hidden');
    document.getElementById('finishField').classList.remove('hidden');
  }
  tryWireAutocomplete();
});

ZOHO.embeddedApp.init();

// ─── Google Maps callback (the maps <script> calls this) ─────────────────
window.__initMaps = function () {
  mapsReady = true;
  tryWireAutocomplete();
};

function tryWireAutocomplete() {
  if (!mapsReady) return;                 // wait for Google script
  if (typeof google === 'undefined') return;
  wireBox('primaryInput', onPrimaryPicked);
  if (currentModule && currentModule !== 'Deals') {
    wireBox('startInput',  function (p) { onSecondaryPicked(p, FIELDS.start); });
    wireBox('finishInput', function (p) { onSecondaryPicked(p, FIELDS.finish); });
  }
  setStatus('Ready — start typing an address.', 'busy');
}

function wireBox(inputId, handler) {
  var input = document.getElementById(inputId);
  if (!input || input.__wired) return;
  input.__wired = true;
  var ac = new google.maps.places.Autocomplete(input, {
    fields: ['formatted_address', 'geometry', 'place_id'],
  });
  ac.addListener('place_changed', function () {
    var place = ac.getPlace();
    if (!place || !place.geometry) {
      setStatus('No details for that address — pick one from the list.', 'err');
      return;
    }
    handler(place);
  });
}

// ─── Primary location: address + geo + place id + timezone ───────────────
function onPrimaryPicked(place) {
  var lat = place.geometry.location.lat();
  var lng = place.geometry.location.lng();
  var record = {};
  record[FIELDS.address] = place.formatted_address;
  record[FIELDS.geo]     = lat + ',' + lng;
  record[FIELDS.placeId] = place.place_id;

  setStatus('Looking up timezone…', 'busy');
  getTimezone(lat, lng).then(function (tz) {
    if (tz) record[FIELDS.timezone] = tz;
    return populate(record).then(function () {
      setStatus('✓ Filled address, coordinates' + (tz ? ', timezone (' + tz + ')' : '') + ' & Place ID.', 'ok');
    });
  }).catch(function () {
    populate(record).then(function () {
      setStatus('✓ Filled address & coordinates. Timezone lookup failed — set it manually.', 'err');
    });
  });
}

// ─── Secondary (start/finish): address string only ───────────────────────
function onSecondaryPicked(place, fieldApi) {
  var record = {};
  record[fieldApi] = place.formatted_address;
  populate(record).then(function () {
    setStatus('✓ Filled ' + fieldApi.replace('_', ' ') + '.', 'ok');
  });
}

// ─── Write values to the record / open form ──────────────────────────────
// Saved record (Edit / Details) → updateRecord with the id.
// New create form (no id) → populate the in-progress form.
function populate(record) {
  if (currentEntityId) {
    var apiData = Object.assign({ id: currentEntityId }, record);
    return ZOHO.CRM.API.updateRecord({
      Entity: currentModule, APIData: apiData, Trigger: [],
    }).catch(function (err) {
      console.error('updateRecord failed', err);
      setStatus('Could not save to the record — check field API names.', 'err');
    });
  }
  return ZOHO.CRM.UI.Record.populate(record).catch(function (err) {
    console.error('populate failed', err);
    setStatus('Could not write to the form — check field API names.', 'err');
  });
}

// ─── Timezone via the Deluge function (server-side, avoids CORS) ─────────
function getTimezone(lat, lng) {
  return ZOHO.CRM.FUNCTION.execute(TZ_FUNCTION, {
    arguments: JSON.stringify({ lat: String(lat), lng: String(lng) }),
  }).then(function (resp) {
    var out = resp && resp.details ? resp.details.output : null;
    if (!out) return null;
    try {
      var parsed = JSON.parse(out);
      return parsed.timeZoneId || parsed.timezone || out;
    } catch (e) {
      return out;
    }
  });
}
