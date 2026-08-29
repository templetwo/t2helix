'use strict';

// SECRET-ASSIGN VECTORS — the labelled-assignment leg of lib/secrets.
//
// WHY THIS FIXTURE EXISTS. The `secret-assign` leg fired on ANY labelled
// assignment (`token=…`, `key: …`) whose value was 8+ non-space characters,
// without ever asking whether the VALUE looked like a secret. The measured cost,
// from seven days of compass_log on the HQ seat: 52 PAUSE and 24 confirmed-OPEN
// on `credential-paste` across four sessions, the dominant shape being a
// labelled assignment whose value is an EXPRESSION — a variable, a call, a file
// read, a subscript, a regex. The specimen that produced this fixture is
// `py-heredoc-reads-env-file` below: a python one-liner that READS the bridge
// env file. It pastes nothing. It was soft-denied, repeatedly.
//
// THE TWO ARMS ARE NOT SYMMETRIC AND MUST NOT BE COLLAPSED.
//
//   fire: false   the gate must NOT stall this. A false PAUSE is a cost paid on
//                 every benign run, and its confirm-token loop trains the seat
//                 to approve credential warnings reflexively — which is the
//                 expensive failure, not the stall.
//   fire: true    the gate MUST stall this. Every one of these is a real literal
//                 secret on a command line. Losing one is a security regression
//                 and the release rule (COMPASS_CONSISTENCY.md, "strictly no
//                 worse than base on every carrier") forbids it outright.
//
// The `char` arm records ACCEPTED RESIDUE — shapes that still fire and are not
// claimed to be zero, in the house style of COMPASS_CONSISTENCY.md's "Known
// false positives (accepted, not zero)". Do not delete an entry to make the
// suite green; if a residue is closed, move it to the `fire: false` arm with the
// commit that closed it.
//
// Every "secret" here is synthetic and generated for this fixture. Recognisable
// prefixes are assembled from fragments so no contiguous key-shaped literal
// exists in source — the same convention test/smoke.js uses, so GitHub push
// protection does not flag the fixture.

const STRIPE = 'sk_' + 'live_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const OPENAI = 'sk' + '-abcdefghijklmnopqrstuvwxyz1234567890ABCD';
const GITHUB = 'ghp' + '_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop';

// ── MUST STAY OPEN ─────────────────────────────────────────────────────────
// A labelled assignment whose value is code. Each names the sub-shape it
// stands for, because they fail for different reasons and a fix that closes
// one is not a fix that closes the others.
const MUST_NOT_FIRE = [
  {
    name: 'py-heredoc-reads-env-file',
    shape: 'subscript/comprehension — the specimen that produced this fixture',
    text: 'token=[l.split("=",1)[1].strip() for l in open(os.path.expanduser("~/.config/sovereign-bridge.env")) if l.startswith("BRIDGE_TOKEN=")][0]'
  },
  {
    name: 'command-substitution-value',
    shape: 'shell $( ) — reads a file, pastes nothing',
    text: 'token=$(cat ~/.config/x.env)'
  },
  {
    name: 'variable-expansion-value',
    shape: 'shell $VAR inside quotes',
    text: 'TOKEN="$BRIDGE_TOKEN"'
  },
  {
    name: 'python-env-lookup-value',
    shape: 'dotted identifier + subscript (also exercises the name-only leg)',
    text: 'api_key: os.environ["X"]'
  },
  {
    name: 'grep-for-credential-shapes',
    shape: 'regex literal — searching FOR credentials is not pasting one',
    text: "grep -rE 'Bearer [A-Za-z0-9_-]{12,}|TOKEN=[^ ]+' dir/"
  },
  {
    name: 'call-expression-value',
    shape: 'bare call — the value is produced, not written down',
    text: 'password = getpass()'
  },
  {
    name: 'brace-expansion-value',
    shape: 'shell ${ } — the sigil arm, not covered by any vector above',
    text: 'export API_TOKEN=${VAULT_LOOKUP_RESULT_VALUE}'
  },
  {
    name: 'backtick-substitution-value',
    shape: 'legacy backtick substitution',
    text: 'password=`cat /run/secrets/dbpass`'
  },
  {
    name: 'source-env-then-use-var',
    shape: 'the carrier the release already guarantees OPEN — regression guard',
    text: 'source ~/.config/sovereign-bridge.env && curl -H "Authorization: Bearer $BRIDGE_TOKEN"'
  }
];

// ── MUST FIRE ──────────────────────────────────────────────────────────────
// Real literal secrets. `leg` names why it must be caught, so a future narrowing
// can tell "still caught, by another leg" from "caught only here".
const MUST_FIRE = [
  {
    name: 'bearer-literal-header',
    leg: 'bearer + stripe-key',
    text: `curl -H "Authorization: Bearer ${STRIPE}"`
  },
  {
    name: 'export-sk-prefixed-key',
    leg: 'sk-key + secret-assign',
    text: `export OPENAI_API_KEY=${OPENAI}`
  },
  {
    name: 'quoted-opaque-literal',
    leg: 'secret-assign ONLY — no prefix leg covers this one',
    text: 'token: "AbCdEfGhIjKlMnOpQrStUvWxYz012345"'
  },
  {
    name: 'bearer-jwt-header',
    leg: 'bearer',
    text: `-H "Authorization: Bearer ${JWT}"`
  },
  {
    name: 'export-github-token',
    leg: 'github-token + secret-assign',
    text: `export GITHUB_TOKEN=${GITHUB}`
  },
  // ── Base-parity guards. Every one of these is asserted PAUSE somewhere else
  // in the suite (test/smoke.js, test/compass-fail-closed.js,
  // test/compass-consistency.js). They are repeated here so that a future edit
  // to this leg fails in THIS file, next to the reasoning, rather than three
  // files away where the cause is not visible.
  {
    name: 'short-literal-password',
    leg: 'secret-assign at the 8-char floor (compass-fail-closed adversarial seed)',
    text: 'password=hunter2hunter2'
  },
  {
    name: 'short-literal-api-key',
    leg: 'name-only + secret-assign (compass-fail-closed CRED, 10-char value)',
    text: 'echo ' + 'api' + '_key=abcdefghij'
  },
  {
    name: 'three-char-value-name-only',
    leg: 'name-only ONLY — value is under the secret-assign floor',
    // `nameOnly` exempts a vector from the detection ⊆ redaction arm. A name-only
    // match is a match on the KEY NAME with no value span, so there is nothing to
    // mask and nothing that can leak — that is the documented design of
    // NAME_ONLY_DETECT, not a gap in it.
    nameOnly: true,
    text: 'echo ' + 'api' + '_key=zzz'
  },
  {
    name: 'special-char-password',
    leg: 'secret-assign with a punctuation-bearing value',
    text: 'password=P@ssw0rd!Sup3r#SecretValue'
  },
  {
    name: 'aws-secret-name-coarse',
    leg: 'name-only (the value is not a real AKID)',
    text: 'export AWS_SECRET_ACCESS_KEY=AKIAEXAMPLE'
  },
  {
    name: 'json-embedded-secret',
    leg: 'secret-assign through the JSON "key":"value" spelling',
    text: '{"password":"aBcD1234EfGh5678IjKl9012MnOp"}'
  }
];

// ── ACCEPTED RESIDUE ───────────────────────────────────────────────────────
// Recorded, not fixed. A bare or dotted identifier with no call and no subscript
// is not distinguishable from an opaque token by shape: `access_token` and
// `sup3rSecretValue12345` are the same string class, and a JWT is a dotted run.
// The leg therefore fails CLOSED here. Asserting it keeps the cost measured.
const ACCEPTED_RESIDUE = [
  {
    name: 'bare-identifier-value',
    why: 'indistinguishable from an opaque token; narrowing it would lose sup3rSecretValue12345',
    text: 'token=access_token_variable'
  },
  {
    name: 'dotted-identifier-value',
    why: 'a dotted run with no call is also the shape of a JWT (header.payload.sig)',
    text: 'api_token=self.session.token'
  }
];

// Also recorded: name-only DELIBERATELY goes quiet when its own value is an
// expression. `AWS_SECRET_ACCESS_KEY=$(vault read …)` reads a secret store; it
// does not paste a secret. This was PAUSE on base and is OPEN now, on purpose.
const DELIBERATE_LOSSES = [
  {
    name: 'name-only-with-expression-value',
    why: 'reading from a secret store is not pasting a credential',
    text: 'export AWS_SECRET_ACCESS_KEY=$(vault read -field=key secret/aws)'
  }
];

module.exports = { MUST_NOT_FIRE, MUST_FIRE, ACCEPTED_RESIDUE, DELIBERATE_LOSSES };
