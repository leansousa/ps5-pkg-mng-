/* Exercise the real scheduler with a controllable execution engine. In
 * particular, status can become idle while worker cleanup remains busy. */
#include "install_queue.h"
#include "installer.h"
#include "pkg_scanner.h"
#include "ws_upload.h"
#include "sqlite3.h"
#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdarg.h>

void install_log(const char *format, ...) { (void)format; }

static pthread_mutex_t engine_mutex = PTHREAD_MUTEX_INITIALIZER;
static installer_status_t status;
static int busy, offline, installed, starts;
static char paths[32][512];
static char session[64];
static char refused_title[32], refusal[128];

int installer_is_busy(void) { pthread_mutex_lock(&engine_mutex); int result = busy; pthread_mutex_unlock(&engine_mutex); return result; }
void installer_get_status(installer_status_t *out) { pthread_mutex_lock(&engine_mutex); *out = status; pthread_mutex_unlock(&engine_mutex); }
int installer_is_network_connected(void) { return !offline; }
int installer_start(const char *path) {
    pthread_mutex_lock(&engine_mutex);
    assert(!busy);
    memset(&status, 0, sizeof(status));
    snprintf(status.pkg_path, sizeof(status.pkg_path), "%s", path);
    snprintf(paths[starts++], sizeof(paths[0]), "%s", path);
    status.total_bytes = 100;
    if (offline) {
        snprintf(status.status_str, sizeof(status.status_str), "submitted");
        status.is_direct_storage = 1;
        status.progress_percent = -1;
    } else { busy = 1; status.is_installing = 1; }
    pthread_mutex_unlock(&engine_mutex);
    return 0;
}
int installer_start_live(const char *path) { return installer_start(path); }
int installer_cancel_path(const char *path) {
    pthread_mutex_lock(&engine_mutex);
    if (!status.is_installing || (path && strcmp(status.pkg_path, path))) { pthread_mutex_unlock(&engine_mutex); return -1; }
    status.is_installing = 0;
    status.failed = 1;
    snprintf(status.status_str, sizeof(status.status_str), "canceled");
    /* Busy deliberately remains true until the test releases cleanup. */
    pthread_mutex_unlock(&engine_mutex);
    return 0;
}

int app_info_check_installed(const char *id, char *version, size_t capacity) { (void)id; (void)version; (void)capacity; return installed; }
int pkg_scanner_find_by_path(const char *path, pkg_detail_t *pkg) { (void)path; (void)pkg; return -1; }
int pkg_parser_parse(const char *path, pkg_detail_t *pkg) {
    if (strstr(path, "slow")) usleep(300000);
    if (strstr(path, "missing")) return -1;
    memset(pkg, 0, sizeof(*pkg));
    snprintf(pkg->title_id, sizeof(pkg->title_id), "PPSA0000%c", path[1]);
    snprintf(pkg->title_name, sizeof(pkg->title_name), "Game %c", path[1]);
    snprintf(pkg->pkg_type_str, sizeof(pkg->pkg_type_str), "%s", strstr(path, "update") ? "update" : strstr(path, "dlc") ? "dlc" : "base");
    pkg->pkg_type = strstr(path, "update") ? PKG_TYPE_UPDATE : strstr(path, "dlc") ? PKG_TYPE_DLC : PKG_TYPE_BASE;
    pkg->file_size = 100;
    return 0;
}
void pkg_scanner_check_install_eligibility(const pkg_detail_t *pkg, pkg_install_eligibility_t *out) {
    memset(out, 0, sizeof(*out));
    out->can_install = pkg->pkg_type == PKG_TYPE_BASE || installed;
    out->disabled_reason = out->can_install ? "" : "Base package is not installed";
    pthread_mutex_lock(&engine_mutex);
    if (refused_title[0] && !strcmp(refused_title, pkg->title_id)) {
        out->can_install = 0;
        out->disabled_reason = refusal;
    }
    pthread_mutex_unlock(&engine_mutex);
}
int ws_direct_owner_matches(const char *owner, const char *sid) { return owner && owner[0] && !strcmp(sid, session); }
int ws_direct_init_owned(const char *filename, uint64_t total, const char *owner, const char *resume,
                         char *sid, size_t capacity) {
    (void)filename; (void)total; (void)owner; (void)resume;
    snprintf(session, sizeof(session), "fixture"); snprintf(sid, capacity, "%s", session); return 0;
}
int ws_direct_cancel_owned(const char *owner, const char *sid) { (void)owner; (void)sid; session[0] = 0; return 0; }

static void finish(int cleanup_finished) {
    pthread_mutex_lock(&engine_mutex);
    status.is_installing = 0; status.completed = 1; status.failed = 0;
    snprintf(status.status_str, sizeof(status.status_str), "completed");
    busy = !cleanup_finished;
    pthread_mutex_unlock(&engine_mutex);
}
static void release_cleanup(void) { pthread_mutex_lock(&engine_mutex); busy = 0; pthread_mutex_unlock(&engine_mutex); }
static int started_count(void) { pthread_mutex_lock(&engine_mutex); int result = starts; pthread_mutex_unlock(&engine_mutex); return result; }

static char *job_state(uint64_t id) {
    char *json = install_queue_to_json();
    sqlite3 *db; sqlite3_stmt *stmt;
    assert(sqlite3_open(":memory:", &db) == SQLITE_OK);
    assert(sqlite3_prepare_v2(db, "SELECT json_extract(value,'$.state') FROM json_each(?,'$.jobs') WHERE json_extract(value,'$.id')=?", -1, &stmt, NULL) == SQLITE_OK);
    sqlite3_bind_text(stmt, 1, json, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, id);
    char *state = sqlite3_step(stmt) == SQLITE_ROW ? strdup((const char *)sqlite3_column_text(stmt, 0)) : strdup("missing");
    sqlite3_finalize(stmt); sqlite3_close(db); free(json); return state;
}
static void wait_state(uint64_t id, const char *expected) {
    for (int i = 0; i < 150; i++) {
        char *state = job_state(id); int matched = !strcmp(state, expected); free(state);
        if (matched) return;
        usleep(20000);
    }
    char *json = install_queue_to_json(); fprintf(stderr, "Expected %llu %s: %s\n", (unsigned long long)id, expected, json); free(json); assert(0);
}
static install_queue_request_t request(const char *path) {
    install_queue_request_t result = {0}; pkg_detail_t pkg;
    snprintf(result.path, sizeof(result.path), "%s", path);
    if (!pkg_parser_parse(path, &pkg)) {
        snprintf(result.title_id, sizeof(result.title_id), "%s", pkg.title_id);
        snprintf(result.kind, sizeof(result.kind), "%s", pkg.pkg_type_str);
    }
    result.total_bytes = 100;
    return result;
}
static void reset(void) {
    install_queue_shutdown();
    pthread_mutex_lock(&engine_mutex);
    memset(&status, 0, sizeof(status)); busy = starts = 0;
    refused_title[0] = refusal[0] = 0;
    pthread_mutex_unlock(&engine_mutex);
    offline = installed = 0;
    assert(install_queue_init() == 0);
}

int main(void) {
    reset();
    install_queue_request_t batch[] = {request("/A/base"), request("/A/update"), request("/B/base")};
    uint64_t ids[3];
    assert(install_queue_add(batch, 3, ids) == 0);
    wait_state(ids[0], "installing");
    assert(install_queue_cancel(ids[1]) == 0);
    wait_state(ids[1], "canceled");
    assert(started_count() == 1);
    finish(0); usleep(250000);
    assert(started_count() == 1); /* status idle is NOT worker idle */
    release_cleanup();
    wait_state(ids[2], "installing");
    assert(!strcmp(paths[1], "/B/base"));
    finish(1); wait_state(ids[2], "completed");

    reset();
    assert(install_queue_add(batch, 3, ids) == 0);
    wait_state(ids[0], "installing");
    assert(install_queue_cancel(ids[0]) == 0);
    release_cleanup();
    wait_state(ids[0], "canceled");
    wait_state(ids[1], "blocked");
    wait_state(ids[2], "installing");
    finish(1); wait_state(ids[2], "completed");
    assert(install_queue_retry(ids[0]) == 0);
    wait_state(ids[0], "installing");
    finish(1); wait_state(ids[1], "installing");
    finish(1); wait_state(ids[1], "completed");

    reset();
    install_queue_request_t checking[] = {request("/A/slowbase"), request("/B/base")};
    assert(install_queue_add(checking, 2, ids) == 0);
    wait_state(ids[0], "checking");
    assert(install_queue_cancel(ids[0]) == 0);
    wait_state(ids[0], "canceled");
    wait_state(ids[1], "installing");
    assert(started_count() == 1 && !strcmp(paths[0], "/B/base"));
    finish(1); wait_state(ids[1], "completed");

    reset();
    offline = 1;
    assert(install_queue_add(batch, 3, ids) == 0);
    wait_state(ids[2], "submitted");
    wait_state(ids[1], "submitted");
    assert(started_count() == 3);
    assert(!strcmp(paths[0], "/A/base") && !strcmp(paths[1], "/A/update"));

    reset();
    install_queue_request_t unavailable[] = {request("/A/missing"), request("/B/base")};
    assert(install_queue_add(unavailable, 2, ids) == 0);
    wait_state(ids[0], "failed"); wait_state(ids[1], "installing");
    finish(1); wait_state(ids[1], "completed");

    reset();
    install_queue_request_t browser = {0};
    snprintf(browser.owner, sizeof(browser.owner), "0123456789abcdef-private-token");
    snprintf(browser.file_key, sizeof(browser.file_key), "game.pkg|100|1");
    snprintf(browser.title_id, sizeof(browser.title_id), "PPSA00001");
    snprintf(browser.kind, sizeof(browser.kind), "base"); browser.total_bytes = 100;
    assert(install_queue_add(&browser, 1, ids) == 0);
    wait_state(ids[0], "preparing");
    char *json = install_queue_to_json(); assert(!strstr(json, "private-token")); free(json);
    assert(!install_queue_browser_selected(ids[0], "another-tab"));
    char sid[64];
    assert(install_queue_open_upload(ids[0], browser.owner, "game.pkg", 99, sid, sizeof(sid)) != 0);
    assert(install_queue_open_upload(ids[0], browser.owner, "game.pkg", 100, sid, sizeof(sid)) == 0);
    assert(install_queue_attach(ids[0], "another-tab", "live:fixture") != 0);
    assert(install_queue_attach(ids[0], browser.owner, "live:fixture") == 0);
    install_queue_disconnect(browser.owner); release_cleanup(); wait_state(ids[0], "canceled");

    const char *redundant[] = {"Installed version is same or newer", "Application is already installed", "DLC is already installed"};
    for (size_t i = 0; i < sizeof(redundant) / sizeof(redundant[0]); i++) {
        reset();
        installed = 1;
        snprintf(refused_title, sizeof(refused_title), "%s", browser.title_id);
        snprintf(refusal, sizeof(refusal), "%s", redundant[i]);
        snprintf(browser.kind, sizeof(browser.kind), "%s", i == 2 ? "dlc" : "base");
        snprintf(browser.content_id, sizeof(browser.content_id), "UP0000-PPSA00001_00-REDUNDANTCONTENT");
        install_queue_request_t duplicates[] = {browser, request("/B/base")};
        assert(install_queue_add(duplicates, 2, ids) == 0);
        wait_state(ids[0], "aborted");
        wait_state(ids[1], "installing");
        assert(started_count() == 1 && !strcmp(paths[0], "/B/base"));
        assert(!install_queue_browser_selected(ids[0], browser.owner));
        assert(install_queue_retry(ids[0]) != 0);
        install_queue_clear_finished();
        wait_state(ids[0], "missing");
        finish(1); wait_state(ids[1], "completed");
    }

    reset();
    size_t count;
    assert(install_queue_add_json("{\"jobs\":[{\"path\":\"/A/base\"},{\"path\":\"live:bad\"}]}", ids, &count) != 0);
    json = install_queue_to_json(); assert(strstr(json, "\"jobs\":[]")); free(json);
    assert(install_queue_add_json("{\"jobs\":[{\"path\":\"/A/base\"},{\"path\":\"/A/base\"}]}", ids, &count) == 0);
    assert(count == 2 && ids[0] == ids[1]);
    assert(install_queue_add_json("{\"jobs\":[]}", ids, &count) != 0);
    assert(install_queue_add_json("{\"jobs\":true}", ids, &count) != 0);
    assert(install_queue_add_json("{\"jobs\":[{\"path\":\"/A/ba\\u0000se\"}]}", ids, &count) != 0);

    /* Test TTL auto-clearing and dependency preservation */
    reset();
    assert(install_queue_get_finished_ttl() == INSTALL_QUEUE_FINISHED_TTL_DEFAULT);
    install_queue_set_finished_ttl(1);
    assert(install_queue_get_finished_ttl() == 1);

    /* Completed job auto-clears after TTL */
    install_queue_request_t single_job = request("/A/base");
    assert(install_queue_add(&single_job, 1, ids) == 0);
    wait_state(ids[0], "installing");
    finish(1);
    wait_state(ids[0], "completed");
    char *st = job_state(ids[0]);
    assert(!strcmp(st, "completed"));
    free(st);
    wait_state(ids[0], "missing");

    /* Submitted job (offline) auto-clears after TTL */
    reset();
    install_queue_set_finished_ttl(1);
    offline = 1;
    assert(install_queue_add(&single_job, 1, ids) == 0);
    wait_state(ids[0], "submitted");
    wait_state(ids[0], "missing");
    offline = 0;

    /* Canceled job auto-clears after TTL */
    reset();
    install_queue_set_finished_ttl(1);
    assert(install_queue_add(&single_job, 1, ids) == 0);
    wait_state(ids[0], "installing");
    assert(install_queue_cancel(ids[0]) == 0);
    release_cleanup();
    wait_state(ids[0], "canceled");
    wait_state(ids[0], "missing");

    /* Failed job auto-clears after TTL */
    reset();
    install_queue_set_finished_ttl(1);
    install_queue_request_t fail_job = request("/A/missing");
    assert(install_queue_add(&fail_job, 1, ids) == 0);
    wait_state(ids[0], "failed");
    wait_state(ids[0], "missing");

    /* Aborted job (redundant browser pkg) auto-clears after TTL */
    reset();
    install_queue_set_finished_ttl(1);
    installed = 1;
    snprintf(refused_title, sizeof(refused_title), "%s", browser.title_id);
    snprintf(refusal, sizeof(refusal), "%s", "Application is already installed");
    snprintf(browser.kind, sizeof(browser.kind), "base");
    assert(install_queue_add(&browser, 1, ids) == 0);
    wait_state(ids[0], "aborted");
    wait_state(ids[0], "missing");

    /* Submitted/completed base needed by pending dependent is NOT cleared even if TTL expires */
    reset();
    install_queue_set_finished_ttl(1);
    install_queue_request_t dep_pair[] = {request("/A/base"), request("/A/update")};
    assert(install_queue_add(dep_pair, 2, ids) == 0);
    wait_state(ids[0], "installing");
    finish(1); /* base completes */
    wait_state(ids[0], "completed");
    wait_state(ids[1], "installing");
    usleep(1200000); /* wait 1.2s > 1s TTL */
    st = job_state(ids[0]);
    assert(!strcmp(st, "completed")); /* base still preserved because update is pending */
    free(st);
    finish(1);
    wait_state(ids[1], "completed");
    /* Now dependent update is completed, base auto-clears */
    wait_state(ids[0], "missing");
    /* Update itself auto-clears after its TTL */
    wait_state(ids[1], "missing");

    /* Multiple dependents keep base alive until ALL dependents finish */
    reset();
    install_queue_set_finished_ttl(1);
    install_queue_request_t multi_deps[] = {request("/A/base"), request("/A/update"), request("/A/dlc")};
    uint64_t multi_ids[3];
    assert(install_queue_add(multi_deps, 3, multi_ids) == 0);
    wait_state(multi_ids[0], "installing");
    finish(1); /* base completes */
    wait_state(multi_ids[0], "completed");
    wait_state(multi_ids[1], "installing");
    usleep(1200000); /* base TTL expires while update is installing */
    st = job_state(multi_ids[0]);
    assert(!strcmp(st, "completed"));
    free(st);
    finish(1); /* update completes */
    wait_state(multi_ids[1], "completed");
    wait_state(multi_ids[2], "installing");
    st = job_state(multi_ids[0]);
    assert(!strcmp(st, "completed")); /* base STILL preserved because DLC is pending */
    free(st);
    usleep(1200000); /* update TTL expires while DLC is still pending */
    st = job_state(multi_ids[0]);
    assert(!strcmp(st, "completed")); /* base still preserved */
    free(st);
    st = job_state(multi_ids[1]);
    assert(!strcmp(st, "missing")); /* update auto-cleared because dependents only need base */
    free(st);
    finish(1); /* dlc completes */
    wait_state(multi_ids[2], "completed");
    wait_state(multi_ids[0], "missing");
    wait_state(multi_ids[2], "missing");

    /* Manual clear_finished clears update but preserves base while dependent DLC is pending */
    reset();
    install_queue_set_finished_ttl(60); /* long TTL so auto-clear doesn't fire */
    assert(install_queue_add(multi_deps, 3, multi_ids) == 0);
    wait_state(multi_ids[0], "installing");
    finish(1); /* base completes */
    wait_state(multi_ids[0], "completed");
    wait_state(multi_ids[1], "installing");
    finish(1); /* update completes */
    wait_state(multi_ids[1], "completed");
    wait_state(multi_ids[2], "installing");
    install_queue_clear_finished();
    st = job_state(multi_ids[0]);
    assert(!strcmp(st, "completed")); /* base preserved because DLC is pending */
    free(st);
    st = job_state(multi_ids[1]);
    assert(!strcmp(st, "missing")); /* update cleared because it's not a base */
    free(st);
    finish(1); /* dlc completes */
    wait_state(multi_ids[2], "completed");
    install_queue_clear_finished();
    wait_state(multi_ids[0], "missing");
    wait_state(multi_ids[2], "missing");

    /* TTL = 0 clears terminal jobs immediately on next tick */
    reset();
    install_queue_set_finished_ttl(0);
    assert(install_queue_get_finished_ttl() == 0);
    assert(install_queue_add(&single_job, 1, ids) == 0);
    wait_state(ids[0], "installing");
    finish(1);
    wait_state(ids[0], "missing");

    /* Negative TTL disables auto-clearing */
    reset();
    install_queue_set_finished_ttl(-1);
    assert(install_queue_add(&single_job, 1, ids) == 0);
    wait_state(ids[0], "installing");
    finish(1);
    wait_state(ids[0], "completed");
    usleep(1200000);
    st = job_state(ids[0]);
    assert(!strcmp(st, "completed"));
    free(st);

    /* Retry before TTL resets expiration */
    reset();
    install_queue_set_finished_ttl(1);
    assert(install_queue_add(&single_job, 1, ids) == 0);
    wait_state(ids[0], "installing");
    assert(install_queue_cancel(ids[0]) == 0);
    release_cleanup();
    wait_state(ids[0], "canceled");
    assert(install_queue_retry(ids[0]) == 0);
    wait_state(ids[0], "installing");
    usleep(1200000);
    st = job_state(ids[0]);
    assert(!strcmp(st, "installing"));
    free(st);
    finish(1);
    wait_state(ids[0], "completed");
    wait_state(ids[0], "missing");

    install_queue_shutdown();
    assert(install_queue_init() == 0);
    json = install_queue_to_json(); assert(strstr(json, "\"jobs\":[]")); free(json);
    install_queue_shutdown();
    puts("Install queue: FIFO, dependencies, redundant browser aborts, cancel, cleanup, retry, submission, source ownership, auto-clearing and atomic batches passed");
}
