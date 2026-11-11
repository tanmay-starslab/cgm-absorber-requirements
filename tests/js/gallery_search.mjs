// Gallery search (docs/tng50/js/gallery.js, UX round 4 fix RC2): parseQuery and matches, no browser. A symbol and the
// number after it ("b 62", "b62", "phi 90", "Φ 90", "L 300") match that field's shown value exactly; a lone number
// matches a whole field value (b, Φ, L, seed), never digits inside the id; words match id, orientation or "yours".
// Usage: node tests/js/gallery_search.mjs
import {parseQuery, matches} from "../../docs/tng50/js/gallery.js";
import {checker} from "./lib/browser.mjs";

const C = checker(), check = C.check;
const E = [
  {id: "rand_b062_a062", orientation: "random", b_kpc: 61.9, azimuth_deg: 62.1, seed: 1},
  {id: "rand_b007_a110_s92676626", orientation: "random", b_kpc: 7.3, azimuth_deg: 110, seed: 92676626},
  {id: "rand_b012_a247_s5", orientation: "random", b_kpc: 12, azimuth_deg: 247, seed: 5},
  {id: "rand_b120_a062_s7", orientation: "random", b_kpc: 120, azimuth_deg: 62, seed: 7},
  {id: "face_b050_a090", orientation: "face-on", b_kpc: 50, azimuth_deg: 90},
  {id: "edge_b100_a030", orientation: "edge-on", b_kpc: 100, azimuth_deg: 30},
  {id: "ray_abc", orientation: "custom", kind: "endpoints", source: "generated", length_kpc: 300, b_kpc: 20}];
const hit = q => E.filter(e => matches(e, parseQuery(q))).map(e => e.id).join(",");

check(hit("") === E.map(e => e.id).join(","), "empty query keeps every entry");
check(hit("b 62") === "rand_b062_a062", `"b 62" matches only b 62 (got ${hit("b 62")})`);
check(hit("b62") === "rand_b062_a062" && hit("B 62 kpc") === "rand_b062_a062", "glued, upper-case and unit forms match the same");
check(hit("b 12") === "rand_b012_a247_s5", `"b 12" does not match b 120 (got ${hit("b 12")})`);
check(hit("phi 62") === "rand_b062_a062,rand_b120_a062_s7" && hit("Φ 62") === hit("phi 62") && hit("az 62°") === hit("phi 62"), "phi, Φ and az match the azimuth");
check(hit("62") === "rand_b062_a062,rand_b120_a062_s7", `a lone number matches whole field values (got ${hit("62")})`);
check(hit("5") === "rand_b012_a247_s5" && hit("0") === "", "a lone number matches the seed but not digits in the id");
check(hit("b 7.3") === "rand_b007_a110_s92676626", "decimal b under 10 kpc");
check(hit("face 50") === "face_b050_a090" && hit("edge 100") === "edge_b100_a030", "orientation word plus number");
check(hit("L 300") === "ray_abc" && hit("yours") === "ray_abc", "custom rays by length and by 'yours'");
check(hit("rand_b062") === "rand_b062_a062", "id substrings still match");
check(hit("b") === hit("") && hit("phi") === hit("") && hit("zzzz") === "", "a lone symbol (mid-typing) filters nothing, not every id with _b; an unknown word matches nothing");

process.exit(C.finish());
