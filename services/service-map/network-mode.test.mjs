import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMap } from './collect.mjs';

test('services without networking do not join the implicit Compose network', () => {
  const map = buildMap({
    config: { services: { app: {}, 'knowledge-media': { network_mode: 'none' } } },
    project: 'test',
  });

  const media = map.services.find((service) => service.id === 'knowledge-media');
  assert.deepEqual(media.networks, []);
  assert.equal(media.internet, false);
  assert.deepEqual(map.networks, [{ id: 'default', internal: false, members: ['app'] }]);
  assert.deepEqual(map.reachable, []);
});
