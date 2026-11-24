/**
 * Text that reaches a terminal or a log line has to be one line.
 *
 * A Wi-Fi SSID is chosen by whoever runs the access point, and Windows hands it back verbatim:
 * it can contain an ESC byte and whatever follows it. Printed unchanged, that is a terminal
 * control sequence - clear the screen, move the cursor, hide input, repaint a line that was
 * never printed - so a network in range could hide or forge what PingLab says about the
 * connection. Endpoint labels are typed by hand but reach the same places.
 *
 * Every control character (C0, DEL, C1 and the two Unicode line separators) becomes a visible
 * "?" instead: the value is still shown, and it cannot drive the terminal or split a log line.
 * Everything else - emoji, accents, CJK - is left exactly as it was, because an SSID is UTF-8
 * and a name is allowed to be interesting.
 */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function oneLine(value) {
  return String(value ?? "").replace(CONTROLS, "?");
}
