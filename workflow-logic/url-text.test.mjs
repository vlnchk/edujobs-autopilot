import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { extractCanonicalUrls } from "./url-text.mjs";

const cases = [
  ["https://example.com/foo)текст", "https://example.com/foo"],
  ["https://example.com/foo, следующий текст", "https://example.com/foo"],
  ["(https://example.com/foo)", "https://example.com/foo"],
  ["[описание](https://example.com/foo)", "https://example.com/foo"],
  ["https://example.com/edit?tab=t.0)короткое тестовое задание", "https://example.com/edit?tab=t.0"],
  ["[описание](https://example.com/foo_(bar(baz))?q=(value)&x=1#section)", "https://example.com/foo_(bar(baz))?q=(value)&x=1#section"],
  ["https://example.com/foo(bar))текст", "https://example.com/foo(bar)"],
  ["«https://example.com/foo»текст", "https://example.com/foo"],
  ["`https://example.com/foo`", "https://example.com/foo"],
  ["'https://example.com/foo'текст", "https://example.com/foo"],
  ["https://example.com/foo]текст", "https://example.com/foo"],
  ["https://example.com/foo}текст", "https://example.com/foo"],
  ["https://example.com/a,b;c!d?name=O'Reilly&x=1#part", "https://example.com/a,b;c!d?name=O'Reilly&x=1#part"],
  ["HTTPS://EXAMPLE.COM:443?x=1#part", "https://example.com/?x=1#part"],
  ["http://Example.com:80", "http://example.com/"],
  ["https://[2001:db8::1]:443/jobs", "https://[2001:db8::1]/jobs"],
  ["https://example.com/%7euser/%2f?q=%29#part", "https://example.com/~user/%2F?q=%29#part"],
  ["https://example.com/вакансия)текст", "https://example.com/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D1%8F"],
];

test("editorial URL boundaries and canonicalization run identically without the URL global", () => {
  const embedded = vm.runInNewContext(`(${extractCanonicalUrls.toString()})`);
  for (const [input, expected] of cases) {
    assert.deepEqual(extractCanonicalUrls(input), [expected], input);
    assert.deepEqual(Array.from(embedded(input)), [expected], input);
  }
  assert.deepEqual(extractCanonicalUrls(null), []);
  assert.deepEqual(extractCanonicalUrls("No links here."), []);
  assert.deepEqual(extractCanonicalUrls("https://example.com/a)текст https://evil.example/new"),
    ["https://example.com/a", "https://evil.example/new"]);
});

test("canonical comparison preserves meaningful differences and encoded boundary punctuation", () => {
  for (const [left, right] of [
    ["/foo", "/Foo"], ["/foo", "/foo/"], ["/?x=1", "/?x=2"],
    ["/#first", "/#second"], ["/a%2Fb", "/a/b"], ["/foo%29", "/foo"],
    ["/foo%2C", "/foo"], ["/foo%3F", "/foo"],
    ["/?x=1&y=2", "/?y=2&x=1"],
  ]) {
    assert.notDeepEqual(extractCanonicalUrls("https://example.com" + left),
      extractCanonicalUrls("https://example.com" + right));
  }
  assert.notDeepEqual(extractCanonicalUrls("https://example.com/foo"), extractCanonicalUrls("https://evil.example/foo"));
});
