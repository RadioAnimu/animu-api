// CI/CD for animu-api — the TypeScript API client consumed by the mobile app
// (and anyone else).
//
// Runs on Node 22 with pnpm, builds ESM + CJS, and archives the built `dist/`
// as `animu-api-dist.tar.gz` so downstream jobs (e.g. animu-mobile-app-release)
// can consume the exact built artifact for a given commit instead of building
// the library from source.
//
// Artifact name is depended on by animu-mobile-app's
// scripts/fetch-animu-api-dist.mjs — keep it stable.

pipeline {
  // agent none so the shared lock is taken before an executor is allocated.
  agent none

  // A parameter (even a free-text one) makes Jenkins expose this job via
  // "Build with Parameters" so it gets a parameterized play button like the
  // other jobs. It has no effect on the build.
  parameters {
    string(name: 'NOTE', defaultValue: '', description: 'Optional note for this run (unused).')
  }

  options {
    timestamps()
    timeout(time: 15, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '10', artifactNumToKeepStr: '50'))
    // Share the lock with the mobile jobs (same physical host).
    lock('animu-build-host')
  }

  environment {
    CI = 'true'
    // Never prompt when corepack fetches the pinned pnpm.
    COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  }

  stages {
    // One stage, one container: with agent none each stage would otherwise get
    // a fresh container and lose corepack/node_modules state between stages.
    stage('Build') {
      agent {
        docker {
          image 'node:22-bookworm'
          args '-u root'
        }
      }
      steps {
        sh '''
          set -eux
          corepack enable
          pnpm install --frozen-lockfile
          pnpm run typecheck
          pnpm test
          pnpm run build
        '''
      }
    }
  }
  post {
    success {
      // Needs a node: with `agent none` a bare sh has no executor.
      node('built-in') {
        sh '''
          set -eux
          test -f dist/esm/index.js
          test -f dist/cjs/index.cjs
          tar -czf animu-api-dist.tar.gz dist
          ls -la animu-api-dist.tar.gz
        '''
        archiveArtifacts artifacts: 'animu-api-dist.tar.gz', fingerprint: true
      }
    }
    failure { echo 'animu-api build failed.' }
  }
}
