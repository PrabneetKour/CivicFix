/**
 * Diagnostic: does this file carry a GPS tag, and when was it taken?
 *
 *   node src/check-photo.js "C:/path/to/photo.jpg"
 *
 * Useful when the app refuses a photo and you want to know whether the tag is really
 * missing or whether something in the pipeline dropped it.
 */
import exifr from 'exifr';

const file = process.argv[2];
if (!file) {
  console.log('Usage: node src/check-photo.js <path-to-photo>');
  process.exit(1);
}

const gps = await exifr.gps(file).catch(() => null);
const times = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'] }).catch(() => null);
const shot = times?.DateTimeOriginal || times?.CreateDate;

console.log('\nFile:', file);
if (gps && Number.isFinite(gps.latitude)) {
  console.log('GPS tag:      FOUND —', gps.latitude, gps.longitude);
  console.log('              https://www.openstreetmap.org/?mlat=' + gps.latitude + '&mlon=' + gps.longitude + '#map=18/' + gps.latitude + '/' + gps.longitude);
} else {
  console.log('GPS tag:      MISSING — this photo would be refused');
}

if (shot) {
  const ageHours = (Date.now() - new Date(shot).getTime()) / 3600000;
  console.log('Taken:       ', new Date(shot).toLocaleString(), `(${ageHours.toFixed(1)} hours ago)`);
  if (ageHours > 24) console.log('              Older than 24 hours — would be refused on freshness');
} else {
  console.log('Taken:        no timestamp (the age check is skipped)');
}
console.log('');
