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
  agent {
    docker {
      image 'node:22-bookworm'
      args '-u root'
    }
  }

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
  }

  environment {
    CI = 'true'
    // Never prompt when corepack fetches the pinned pnpm.
    COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  }

  stages {
    stage('Install') {
      steps {
        sh '''
          set -eux
          corepack enable
          pnpm install --frozen-lockfile
        '''
      }
    }

    stage('Typecheck') {
      steps {
        sh 'pnpm run typecheck'
      }
    }

    stage('Test') {
      steps {
        sh 'pnpm test'
      }
    }

    stage('Build (ESM + CJS)') {
      steps {
        sh 'pnpm run build'
      }
    }
  }

  post {
    success {
      sh '''
        set -eux
        test -f dist/esm/index.js
        test -f dist/cjs/index.cjs
        tar -czf animu-api-dist.tar.gz dist
        ls -la animu-api-dist.tar.gz
      '''
      archiveArtifacts artifacts: 'animu-api-dist.tar.gz', fingerprint: true
    }
    failure { echo 'animu-api build failed.' }
  }
}
