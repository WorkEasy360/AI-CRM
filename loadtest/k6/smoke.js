/**
 * One VU, one iteration of the browse scenario: a quick connectivity/auth check before a real stage.
 *   ./run.sh smoke   (or: k6 run --http-debug=headers /scripts/smoke.js)
 */
import { browse } from './scenarios.js';

export const options = { vus: 1, iterations: 1, noCookiesReset: true };

export default function () {
  browse();
}
