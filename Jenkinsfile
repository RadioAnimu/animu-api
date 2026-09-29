// CI/CD for animu-api — the TypeScript API client consumed by the mobile app
// (and anyone else).
//
// Runs on Node 22, builds ESM + CJS, and archives the built `dist/` as
// `animu-api-dist.tar.gz` so downstream jobs (e.g. animu-mobile-app-release)
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

  options {
    timestamps()
    timeout(time: 15, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '10', artifactNumToKeepStr: '50'))
  }

  environment {
    CI = 'true'
    NPM_CONFIG_FUND = 'false'
    NPM_CONFIG_AUDIT = 'false'
  }

  stages {
    stage('Install') {
      steps {
        sh 'npm install --no-audit --no-fund'
      }
    }

    stage('Typecheck') {
      steps {
        sh 'npm run typecheck'
      }
    }

    stage('Test') {
      steps {
        sh 'npm test'
      }
    }

    stage('Build (ESM + CJS)') {
      steps {
        sh 'npm run build'
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
