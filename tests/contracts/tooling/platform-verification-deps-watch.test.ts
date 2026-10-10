import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../../.github/workflows/platform-verification.yml', import.meta.url), 'utf8');
const jobBlock = (name: string) => workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|(?![\\s\\S]))`, 'mu'))?.[0] ?? '';

// Frozen verify job from base 8208517a24e17e7af44eab9cbbf8e700fa333e25; do not regenerate from the candidate.
const baseVerifyJob = `  verify:
    name: platform verify (\${{ matrix.os }}, node \${{ matrix.node }})
    runs-on: \${{ matrix.os }}
    # Run 36884716187: Linux 14m05s/14m20s; bound stalled cells without increasing the budget.
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
        # Both versions are required. Node 26 is the planned default after LTS (2026-10-28).
        node: ['24', '26']
    steps:
      - name: Preserve repository bytes on Windows
        if: runner.os == 'Windows'
        run: git config --global core.autocrlf false
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with: { node-version: '\${{ matrix.node }}', cache: npm }
      - name: Canonical temporary parent for every fixture runner
        id: temporary_parent
        run: node scripts/ci-temporary-environment.mjs
      - run: npm ci
        id: install
      - name: Prepare the pinned Docker test image (Linux)
        id: docker_fixture
        if: runner.os == 'Linux'
        run: bash scripts/ci-docker-fixture.sh
      - name: Restore locked bubblewrap downloads (Linux)
        id: bwrap_cache
        if: runner.os == 'Linux'
        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .pack/bwrap/cache
          key: bwrap-\${{ hashFiles('packaging/bwrap/bwrap.lock.json') }}
      - name: Build and stage the locked bundled bubblewrap (Linux)
        id: bubblewrap
        if: runner.os == 'Linux'
        run: |
          node scripts/build-bwrap.mjs --arch x86_64 --out "$RUNNER_TEMP/bwrap-x86_64"
          node scripts/build-bwrap.mjs --stage-dev "$RUNNER_TEMP/bwrap-x86_64"
          echo "DECKENT_GLOBAL_HOME=$RUNNER_TEMP/deckent-global" >> "$GITHUB_ENV"
      - name: Save verified bubblewrap downloads before tests (Linux)
        if: runner.os == 'Linux' && steps.bwrap_cache.outputs.cache-hit != 'true'
        uses: actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: .pack/bwrap/cache
          key: \${{ steps.bwrap_cache.outputs.cache-primary-key }}
      - name: Prove the built product selects bubblewrap before tests (Linux)
        id: shell_realm
        if: runner.os == 'Linux'
        run: |
          # Only this ephemeral GitHub runner: the required mount/rename proofs need user namespaces.
          if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0; fi
          node scripts/build.mjs
          node scripts/ci-shell-realm.mjs
      - name: Verify and retain the original exit code
        id: verification
        shell: bash
        # Leaves time for summary/upload within the existing 30-minute job bound.
        timeout-minutes: 20
        run: |
          mkdir -p .pack/ci-evidence
          set -o pipefail
          npm run verify 2>&1 | tee .pack/ci-evidence/verify.log
        env:
          DECKENT_TEST_STARTUP_COST: '1'
          # Hosted macOS/Windows per-test bound (main run 37285853079: six 30-54 s completions timed out at 30 s); Linux keeps 30 s.
          DECKENT_TEST_TIMEOUT_MS: "\${{ runner.os == 'Linux' && '30000' || '120000' }}"
      - name: Collect verification summary
        if: always()
        run: node scripts/ci-verification-summary.mjs
        env:
          DECKENT_CI_VERIFY_OUTCOME: '\${{ steps.verification.outcome }}'
          DECKENT_CI_TEMP_OUTCOME: '\${{ steps.temporary_parent.outcome }}'
          DECKENT_CI_INSTALL_OUTCOME: '\${{ steps.install.outcome }}'
          DECKENT_CI_DOCKER_OUTCOME: '\${{ steps.docker_fixture.outcome }}'
          DECKENT_CI_BWRAP_OUTCOME: '\${{ steps.bubblewrap.outcome }}'
          DECKENT_CI_REALM_OUTCOME: '\${{ steps.shell_realm.outcome }}'
      - name: Upload verification summary
        if: always()
        # Official actions/upload-artifact v7.0.1, verified 2026-10-03 (proof/CI-FIX-2026-10-03/sources.md).
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: verify-\${{ matrix.os }}-node\${{ matrix.node }}-\${{ github.run_attempt }}
          path: .pack/ci-evidence/
          if-no-files-found: error
          retention-days: 7
`;

describe('platform verification dependency watch schedule', () => {
  const depsWatch = jobBlock('deps-watch');

  it('preserves the daily cron and adds the Monday weekly cron', () => {
    expect(workflow).toContain("  schedule:\n    - cron: '17 2 * * *'\n    - cron: '41 3 * * 1'\n");
    expect(workflow).toContain('  workflow_dispatch:\n');
  });

  it('runs the watch only on the weekly schedule or manual dispatch, never the daily schedule', () => {
    expect(depsWatch).not.toBe('');
    expect(depsWatch).toMatch(/^ {4}if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.schedule == '41 3 \* \* 1'$/mu);
    expect(depsWatch).toMatch(/^ {4}runs-on: ubuntu-latest$/mu);
    expect(depsWatch).toMatch(/^ {4}permissions:\n {6}contents: read$/mu);
  });

  it('pins every action to a full SHA and reuses the verify checkout and setup-node pins with Node 24', () => {
    const actions = [...depsWatch.matchAll(/^\s+(?:- )?uses: (\S+)/gmu)].map(match => match[1]);
    expect(actions.length).toBeGreaterThanOrEqual(2);
    for (const action of actions) expect(action).toMatch(/^[\w/-]+@[a-fA-F0-9]{40}$/u);
    for (const action of ['checkout', 'setup-node']) {
      const pin = baseVerifyJob.match(new RegExp(`uses: (actions/${action}@[a-f0-9]{40})`, 'u'))?.[1];
      expect(pin).toBeDefined();
      expect(depsWatch).toContain(`uses: ${pin}`);
    }
    expect(depsWatch).toMatch(/node-version: '24'/u);
  });

  it('installs locked dependencies and runs the watch with its temporary report directory, preserving failure', () => {
    expect(depsWatch).toMatch(/^ {6}- run: npm ci$/mu);
    expect(depsWatch).toContain('run: node scripts/deps-watch.mjs "$RUNNER_TEMP/deps-watch"');
    expect(depsWatch).not.toMatch(/continue-on-error:|\|\| true/u);
    expect(depsWatch.indexOf('run: npm ci')).toBeLessThan(depsWatch.indexOf('run: node scripts/deps-watch.mjs'));
  });

  it('retains reports even on policy failure using the existing upload-artifact pin', () => {
    const uploadPin = baseVerifyJob.match(/uses: (actions\/upload-artifact@[a-f0-9]{40})/u)?.[1];
    expect(uploadPin).toBeDefined();
    expect(depsWatch).toContain(`if: always()\n        uses: ${uploadPin}`);
    expect(depsWatch).toContain('path: ${{ runner.temp }}/deps-watch/');
  });

  it('preserves the existing verify job byte-for-byte', () => {
    expect(jobBlock('verify')).toBe(baseVerifyJob);
  });
});
