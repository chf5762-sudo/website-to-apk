<template>
  <main class="app-shell">
    <iframe
      class="remote-frame"
      src="/remote.html"
      title="Remote Frontend"
      loading="eager"
    />
  </main>
</template>

<style scoped>
.app-shell {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #000;
}

.remote-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
</style>
