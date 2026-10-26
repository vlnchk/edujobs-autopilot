// Run inside the cached n8n 2.35.7 image with --network none.
// This is a capability probe, not a workflow implementation or live API test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const version = execFileSync('n8n', ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, '2.35.7');
const root = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'n8n/node_modules/n8n-nodes-base/dist');
const { Telegram } = require(join(root, 'nodes/Telegram/Telegram.node.js'));
const { TelegramApi } = require(join(root, 'credentials/TelegramApi.credentials.js'));
const native = new Telegram();
const resources = native.description.properties.find(p => p.name === 'resource').options.map(o => o.value);
assert.deepEqual(resources, ['chat', 'callback', 'file', 'message']);
const operations = native.description.properties.filter(p => p.name === 'operation').flatMap(p => p.options.map(o => o.value));
assert.equal(operations.includes('getMe'), false);
assert.equal(operations.includes('info'), false);
// The credential editor's connectivity test is not a workflow output.
assert.equal(new TelegramApi().test.request.url, '/getMe');

async function execute(parameters, response, error) {
  const calls = [];
  const context = {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (key, index, fallback) => parameters[key] ?? fallback,
    getNode: () => ({ name: 'Synthetic Telegram probe', type: 'n8n-nodes-base.telegram', typeVersion: 1.2 }),
    getInstanceId: () => 'synthetic-instance',
    continueOnFail: () => true,
    // Deliberately different from the expected bot ID requested below.
    getCredentials: async () => ({ accessToken: '222:synthetic-only', baseUrl: 'https://telegram.invalid' }),
    helpers: {
      request: async options => {
        calls.push(structuredClone(options));
        if (error) throw error;
        return structuredClone(response);
      },
      returnJsonArray: value => (Array.isArray(value) ? value : [value]).map(json => ({ json })),
      constructExecutionMetaData: items => items,
    },
  };
  const output = await native.execute.call(context);
  return { calls, output };
}
const memberResponse = { ok: true, result: {
  status: 'administrator', can_post_messages: true, user: { id: 111, is_bot: true, username: 'expected_bot' },
} };
const member = await execute({ resource: 'chat', operation: 'member', chatId: '-1001234567890', userId: '111' }, memberResponse);
assert.equal(member.calls.length, 1);
assert.equal(member.calls[0].uri, 'https://telegram.invalid/bot222:synthetic-only/getChatMember');
assert.deepEqual(member.calls[0].body, { chat_id: '-1001234567890', user_id: '111' });
assert.deepEqual(member.output[0][0].json, memberResponse);
// It returns the *requested* member; no request verifies the caller's identity.
assert.equal(member.calls.some(c => c.uri.endsWith('/getMe')), false);
const unsupported = await execute({ resource: 'bot', operation: 'info' }, {});
assert.equal(unsupported.calls.length, 0);
assert.match(unsupported.output[0][0].json.error, /not known/);

assert.ok(operations.includes('administrators'));
const administrators = [
  { status: 'creator', user: { id: 333, is_bot: false } },
  { status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true } },
];
const admins = await execute({ resource: 'chat', operation: 'administrators', chatId: '-1001234567890' },
  { ok: true, result: administrators });
assert.equal(admins.calls.length, 1);
assert.equal(admins.calls[0].uri, 'https://telegram.invalid/bot222:synthetic-only/getChatAdministrators');
assert.deepEqual(admins.calls[0].body, { chat_id: '-1001234567890' });
assert.equal(admins.calls[0].body.return_bots, undefined);
assert.deepEqual(admins.output[0].map(item => item.json), administrators);
const chatResponse = { ok: true, result: { id: -1001234567890, type: 'channel' } };
const chat = await execute({ resource: 'chat', operation: 'get', chatId: '-1001234567890' }, chatResponse);
assert.equal(chat.calls[0].uri, 'https://telegram.invalid/bot222:synthetic-only/getChat');
assert.deepEqual(chat.output[0][0].json, chatResponse);

const sendParameters = () => ({ resource: 'message', operation: 'sendMessage', chatId: '-1001234567890',
  text: '...start &gt;&gt;', replyMarkup: 'none', additionalFields: {
    parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: false, appendAttribution: false,
  } });
const acknowledgement = { ok: true, result: { message_id: 123, date: 1789600000, chat: { id: -1001234567890, type: 'channel' } } };
const sent = await execute(sendParameters(), acknowledgement);
assert.equal(sent.calls.length, 1);
assert.deepEqual(sent.output[0][0].json, acknowledgement);
assert.deepEqual(sent.calls[0].body, { chat_id: '-1001234567890', text: '...start &gt;&gt;',
  parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: false });
const limited = await execute(sendParameters(), null, {
  message: 'Too Many Requests', statusCode: 429,
  response: { body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 17 } } },
});
assert.equal(limited.calls.length, 1);
assert.equal(typeof limited.output[0][0].json.error, 'string');
assert.deepEqual(Object.keys(limited.output[0][0].json), ['error']);
assert.equal(limited.output[0][0].json.parameters, undefined);
for (const errorCode of [400, 401, 403, 404, 500]) {
  const rejected = await execute(sendParameters(), null, {
    message: 'Synthetic rejection', statusCode: errorCode,
    response: { body: { ok: false, error_code: errorCode, description: 'Synthetic rejection' } },
  });
  assert.deepEqual(Object.keys(rejected.output[0][0].json), ['error']);
  assert.equal(typeof rejected.output[0][0].json.error, 'string');
}
console.log(JSON.stringify({ n8n_version: version, live_api_calls: 0,
  native_send_acknowledgement: 'PASS', native_html_preview_notification_attribution: 'PASS',
  requested_member_is_not_caller_identity: 'PASS', unsupported_bot_operation: 'PASS',
  structured_retry_after_on_continue_output: false, structured_rejection_on_continue_output: false, runtime_getMe: false,
  native_administrators_identity_and_permission: 'PASS', native_get_chat: 'PASS' }));
