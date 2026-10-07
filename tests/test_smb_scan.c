#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdatomic.h>
#include "pkg_scanner.h"
#include "pkg_cache.h"
#include "test_fixture.h"

extern void (*mock_smb_opendir_hook)(const char *);
extern const char *mock_smb_fail_path;
extern _Atomic unsigned int mock_smb_file_opens;
extern _Atomic unsigned int mock_smb_reads_with_open_directory;
static pthread_mutex_t gate = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t entered = PTHREAD_COND_INITIALIZER;
static int opens;
static void slow_directory(const char *path) {
    (void)path;
    pthread_mutex_lock(&gate);
    opens++;
    pthread_cond_broadcast(&entered);
    pthread_mutex_unlock(&gate);
    usleep(20000);
}
static void *scan(void *arg) {
    (void)arg;
    pkg_scanner_scan();
    return NULL;
}
int main(void) {
    char root[] = "/tmp/mock_smb/large-XXXXXX";
    mkdir("/tmp/mock_smb", 0700);
    assert(mkdtemp(root));
    char cache[] = "/tmp/pkg-large-cache-XXXXXX";
    assert(mkdtemp(cache));
    setenv("PKG_CACHE_DIR", cache, 1);
    char settings_path[512];
    snprintf(settings_path, sizeof(settings_path), "%s/settings.json", cache);
    setenv("PKG_SETTINGS_PATH", settings_path, 1);
    setenv("PKG_SCAN_DIR", "/tmp/pkg-large-no-local-drive", 1);
    const char *folders[] = {"games", "updates", "dlc"};
    for (int d = 0; d < 3; d++) {
        char path[512];
        snprintf(path, sizeof(path), "%s/%s", root, folders[d]);
        assert(mkdir(path, 0700) == 0);
        for (int i = 0; i < 1000; i++) {
            snprintf(path, sizeof(path), "%s/%s/%04d.pkg", root, folders[d], i);
            char title_id[32], title[64];
            snprintf(title_id, sizeof(title_id), "CUSA%05d", 90000 + i);
            snprintf(title, sizeof(title), "Large share title %04d", i);
            assert(fixture_write_ps4_pkg(path, title_id, title,
                        d == 1 ? "gp" : d == 2 ? "ac" : "gd", "01.00") == 0);
        }
    }
    pkg_scanner_init();
    app_settings_t settings = {0};
    settings.smb_share_count = 1;
    smb_share_config_t *cfg = &settings.smb_shares[0];
    cfg->enabled = 1;
    cfg->port = 445;
    strcpy(cfg->id, "smb_large");
    strcpy(cfg->server, "mock");
    strcpy(cfg->share, "pkgs");
    strcpy(cfg->path, root + strlen("/tmp/mock_smb/"));
    assert(pkg_cache_set_settings(&settings) == 0);
    assert(pkg_scanner_scan() == 3000);
    assert(atomic_load(&mock_smb_reads_with_open_directory) == 0);
    pkg_scanner_init();
    assert(pkg_scanner_get_count() == 3000);
    int changed = -1;
    assert(pkg_scanner_scan_quick("smb_large", &changed) == 3000);
    assert(changed == 0);
    puts("3,000 files: full scan and unchanged quick scan passed");
    fflush(stdout);

    mock_smb_opendir_hook = slow_directory;
    pthread_t first;
    assert(pthread_create(&first, NULL, scan, NULL) == 0);
    pthread_mutex_lock(&gate);
    while (!opens) pthread_cond_wait(&entered, &gate);
    pthread_mutex_unlock(&gate);
    /* A retry during the count pass must join/skip, never enqueue a new scan. */
    pkg_scanner_scan();
    pthread_join(first, NULL);
    mock_smb_opendir_hook = NULL;
    printf("Directory opens after overlapping requests: %d (expected 8)\n", opens);
    fflush(stdout);
    assert(opens == 8);
    /* Background admission publishes status before pre-counting and never queues. */
    opens = 0;
    mock_smb_opendir_hook = slow_directory;
    assert(pkg_scanner_start_scan() == 1);
    pkg_scan_status_t status;
    pkg_scanner_get_status(&status);
    assert(status.is_scanning);
    assert(pkg_scanner_start_scan() == 0);
    char *drives = pkg_scanner_drives_to_json();
    assert(drives); /* Catalog access works while the scan is in SMB I/O. */
    free(drives);
    do {
        usleep(1000);
        pkg_scanner_get_status(&status);
    } while (status.is_scanning);
    mock_smb_opendir_hook = NULL;
    assert(opens == 8);
    assert(status.total_files == 3000 && status.processed_files == 3000);
    assert(status.failed_sources == 0);
    assert(pkg_scanner_get_count() == 3000);
    puts("Background admission, status, catalog access and completion passed");

    /* Every entry beyond the old 256-entry cutoff is reachable exactly once. */
    smb_dir_entry_t entries[64];
    char folder[512], after[260] = {0}, err[256];
    snprintf(folder, sizeof(folder), "%s/games", cfg->path);
    unsigned int before = atomic_load(&mock_smb_file_opens);
    int more = 1, seen = 0;
    while (more) {
        int n = smb_client_list_dir_page(cfg, folder, after, entries, 64, &more, err, sizeof(err));
        assert(n > 0 && n <= 64);
        for (int i = 0; i < n; i++) {
            char expected[32];
            snprintf(expected, sizeof(expected), "%04d.pkg", seen++);
            assert(strcmp(entries[i].name, expected) == 0);
            assert(entries[i].size > 0);
        }
        snprintf(after, sizeof(after), "F:%s", entries[n - 1].name);
    }
    assert(seen == 1000);
    assert(atomic_load(&mock_smb_file_opens) == before);
    assert(smb_client_list_dir_page(cfg, folder, "bad", entries, 64, &more, err, sizeof(err)) < 0);
    assert(smb_client_list_dir_page(cfg, "../escape", "", entries, 64, &more, err, sizeof(err)) < 0);
    puts("1,000-entry cursor traversal passed without opening any PKG files");

    /* A failed nested folder is an incomplete scan, not deletion of its files. */
    mock_smb_fail_path = folder;
    assert(smb_client_scan_share(cfg, NULL, NULL) < 0);
    changed = -1;
    assert(pkg_scanner_scan_quick("smb_large", &changed) == 3000);
    assert(changed == 0);
    pkg_scanner_scan();
    pkg_scanner_get_status(&status);
    assert(status.failed_sources == 1);
    mock_smb_fail_path = NULL;
    assert(pkg_scanner_scan() == 3000);

    cfg->browse_only = 1;
    assert(pkg_cache_set_settings(&settings) == 0);
    opens = 0;
    before = atomic_load(&mock_smb_file_opens);
    mock_smb_opendir_hook = slow_directory;
    assert(pkg_scanner_scan_quick("smb_large", &changed) == 0);
    assert(changed == 1);
    assert(pkg_scanner_scan() == 0);
    pkg_scanner_scan_quick(NULL, &changed);
    assert(opens == 0 && atomic_load(&mock_smb_file_opens) == before);
    mock_smb_opendir_hook = NULL;
    drives = pkg_scanner_drives_to_json();
    assert(strstr(drives, "smb_large") && strstr(drives, "\"clickable\":true"));
    free(drives);
    pkg_scanner_init();
    app_settings_t restored;
    pkg_cache_get_settings(&restored);
    assert(restored.smb_shares[0].browse_only == 1);
    pkg_detail_t selected;
    char url[512];
    snprintf(url, sizeof(url), "smb://mock/pkgs/%s/0999.pkg", folder);
    assert(pkg_parser_parse(url, &selected) == 0);
    assert(strcmp(selected.title_id, "CUSA90999") == 0);
    assert(pkg_scanner_get_count() == 0);
    puts("Browse-only persistence, zero scan I/O and individual-file parsing passed");

    /* Remove only this run's fixture files and private cache. */
    for (int d = 0; d < 3; d++) {
        char path[512];
        for (int i = 0; i < 1000; i++) {
            snprintf(path, sizeof(path), "%s/%s/%04d.pkg", root, folders[d], i);
            unlink(path);
        }
        snprintf(path, sizeof(path), "%s/%s", root, folders[d]);
        rmdir(path);
    }
    rmdir(root);
    /* SMB quick scan: package rename and recovery test */
    char smb_test_root[] = "/tmp/mock_smb/smb-rename-XXXXXX";
    assert(mkdtemp(smb_test_root));
    for (int i = 0; i < 5; i++) {
        char pkg_file[512];
        snprintf(pkg_file, sizeof(pkg_file), "%s/%04d.pkg", smb_test_root, i);
        char tid[32], tname[64];
        snprintf(tid, sizeof(tid), "CUSA9999%d", i);
        snprintf(tname, sizeof(tname), "Mock Title %d", i);
        assert(fixture_write_ps4_pkg(pkg_file, tid, tname, "gd", "01.00") == 0);
    }

    memset(&settings, 0, sizeof(settings));
    settings.smb_share_count = 1;
    cfg = &settings.smb_shares[0];
    cfg->enabled = 1;
    cfg->port = 445;
    strcpy(cfg->id, "smb_rename_test");
    strcpy(cfg->server, "mock");
    strcpy(cfg->share, "pkgs");
    strcpy(cfg->path, smb_test_root + strlen("/tmp/mock_smb/"));
    assert(pkg_cache_set_settings(&settings) == 0);

    pkg_scanner_init();
    assert(pkg_scanner_scan() == 5);
    char *json = pkg_scanner_to_json();
    assert(json);
    /* Verify mtime is non-zero in json */
    assert(strstr(json, "\"mtime\":0") == NULL);
    free(json);

    /* Quick scan when unchanged must return changed == 0 */
    changed = -1;
    assert(pkg_scanner_scan_quick("smb_rename_test", &changed) == 5);
    assert(changed == 0);

    /* Rename 0000.pkg to 0000_renamed.pkg on SMB */
    char old_path[512], new_path[512];
    snprintf(old_path, sizeof(old_path), "%s/0000.pkg", smb_test_root);
    snprintf(new_path, sizeof(new_path), "%s/0000_renamed.pkg", smb_test_root);
    assert(rename(old_path, new_path) == 0);

    /* Quick scan must reflect rename without losing any other packages */
    changed = -1;
    int q_cnt = pkg_scanner_scan_quick("smb_rename_test", &changed);
    assert(q_cnt == 5);
    assert(changed == 1);

    json = pkg_scanner_to_json();
    assert(json);
    assert(strstr(json, "0000_renamed.pkg") != NULL);
    assert(strstr(json, "0000.pkg") == NULL);
    assert(strstr(json, "0001.pkg") != NULL);
    assert(strstr(json, "0002.pkg") != NULL);
    assert(strstr(json, "0003.pkg") != NULL);
    assert(strstr(json, "0004.pkg") != NULL);
    free(json);

    /* Second quick scan: unchanged, must return changed == 0 */
    changed = -1;
    assert(pkg_scanner_scan_quick("smb_rename_test", &changed) == 5);
    assert(changed == 0);

    /* Test recovery: simulate catalog corruption where g_packages was truncated to 1 package
     * but g_scanned_files has all 5 files recorded (the exact bug state). */
    char manifest_path[512];
    snprintf(manifest_path, sizeof(manifest_path), "%s/manifest.json", cache);
    FILE *mf = fopen(manifest_path, "r");
    assert(mf != NULL);
    fseek(mf, 0, SEEK_END);
    long mlen = ftell(mf);
    fseek(mf, 0, SEEK_SET);
    char *mbuf = (char *)malloc(mlen + 1);
    assert(mbuf != NULL);
    assert(fread(mbuf, 1, mlen, mf) == (size_t)mlen);
    mbuf[mlen] = '\0';
    fclose(mf);

    char *pkgs = strstr(mbuf, "\"packages\": [");
    assert(pkgs != NULL);
    char *first_pkg_end = strstr(pkgs, "},\n    {");
    if (first_pkg_end) {
        first_pkg_end[1] = '\n';
        first_pkg_end[2] = ' ';
        first_pkg_end[3] = ' ';
        first_pkg_end[4] = ']';
        first_pkg_end[5] = '\n';
        first_pkg_end[6] = '}';
        first_pkg_end[7] = '\0';
        mf = fopen(manifest_path, "w");
        assert(mf != NULL);
        fputs(mbuf, mf);
        fclose(mf);
    }
    free(mbuf);

    /* Reload corrupted manifest */
    pkg_scanner_init();
    assert(pkg_scanner_get_count() == 1);

    /* Next quick scan must detect the missing packages and recover all 5! */
    changed = -1;
    assert(pkg_scanner_scan_quick("smb_rename_test", &changed) == 5);
    assert(changed == 1);
    json = pkg_scanner_to_json();
    assert(json);
    assert(strstr(json, "0000_renamed.pkg") != NULL);
    assert(strstr(json, "0001.pkg") != NULL);
    assert(strstr(json, "0002.pkg") != NULL);
    assert(strstr(json, "0003.pkg") != NULL);
    assert(strstr(json, "0004.pkg") != NULL);
    free(json);

    /* Cleanup smb_test_root */
    unlink(new_path);
    for (int i = 1; i < 5; i++) {
        char pkg_file[512];
        snprintf(pkg_file, sizeof(pkg_file), "%s/%04d.pkg", smb_test_root, i);
        unlink(pkg_file);
    }
    rmdir(smb_test_root);
    puts("SMB rename and catalog recovery quick scan passed");

    /* Test: Multiple Samba locations on the same server/share retaining distinct paths (#32) */
    char smb_multi_root[] = "/tmp/mock_smb/multi-XXXXXX";
    assert(mkdtemp(smb_multi_root));
    char ps5_dir[512], ps4_dir[512];
    snprintf(ps5_dir, sizeof(ps5_dir), "%s/ps5_games", smb_multi_root);
    snprintf(ps4_dir, sizeof(ps4_dir), "%s/ps4_games", smb_multi_root);
    assert(mkdir(ps5_dir, 0700) == 0);
    assert(mkdir(ps4_dir, 0700) == 0);

    /* 2 pkgs in ps5_games, 3 pkgs in ps4_games */
    char p1[512], p2[512], p3[512], p4[512], p5[512];
    snprintf(p1, sizeof(p1), "%s/0001.pkg", ps5_dir);
    snprintf(p2, sizeof(p2), "%s/0002.pkg", ps5_dir);
    snprintf(p3, sizeof(p3), "%s/0001.pkg", ps4_dir);
    snprintf(p4, sizeof(p4), "%s/0002.pkg", ps4_dir);
    snprintf(p5, sizeof(p5), "%s/0003.pkg", ps4_dir);
    assert(fixture_write_ps4_pkg(p1, "CUSA91001", "PS5 Game 1", "gd", "01.00") == 0);
    assert(fixture_write_ps4_pkg(p2, "CUSA91002", "PS5 Game 2", "gd", "01.00") == 0);
    assert(fixture_write_ps4_pkg(p3, "CUSA92001", "PS4 Game 1", "gd", "01.00") == 0);
    assert(fixture_write_ps4_pkg(p4, "CUSA92002", "PS4 Game 2", "gd", "01.00") == 0);
    assert(fixture_write_ps4_pkg(p5, "CUSA92003", "PS4 Game 3", "gd", "01.00") == 0);

    memset(&settings, 0, sizeof(settings));
    settings.smb_share_count = 2;
    smb_share_config_t *s_ps5 = &settings.smb_shares[0];
    s_ps5->enabled = 1;
    s_ps5->port = 445;
    strcpy(s_ps5->id, "smb_ps5");
    strcpy(s_ps5->label, "PS5 Games");
    strcpy(s_ps5->server, "smb://mock/");
    strcpy(s_ps5->share, "pkgs");
    snprintf(s_ps5->path, sizeof(s_ps5->path), "%s/ps5_games", smb_multi_root + strlen("/tmp/mock_smb/"));

    smb_share_config_t *s_ps4 = &settings.smb_shares[1];
    s_ps4->enabled = 1;
    s_ps4->port = 445;
    strcpy(s_ps4->id, "smb_ps4");
    strcpy(s_ps4->label, "PS4 Games");
    strcpy(s_ps4->server, "mock");
    strcpy(s_ps4->share, "pkgs");
    snprintf(s_ps4->path, sizeof(s_ps4->path), "%s/ps4_games", smb_multi_root + strlen("/tmp/mock_smb/"));
    /* Introduce Windows-style backslashes in path */
    for (char *c = s_ps4->path; *c; c++) { if (*c == '/') *c = '\\'; }
    assert(pkg_cache_set_settings(&settings) == 0);

    pkg_scanner_init();
    assert(pkg_scanner_scan() == 5);

    /* Verify drives registered distinct paths and distinct package counts */
    size_t d_count = pkg_scanner_get_drive_count();
    pkg_drive_t d_ps5 = {0}, d_ps4 = {0};
    int found_d_ps5 = 0, found_d_ps4 = 0;
    for (size_t d = 0; d < d_count; d++) {
        pkg_drive_t drv;
        if (pkg_scanner_get_drive_at(d, &drv) == 0) {
            if (strcmp(drv.id, "smb_ps5") == 0) {
                d_ps5 = drv;
                found_d_ps5 = 1;
            } else if (strcmp(drv.id, "smb_ps4") == 0) {
                d_ps4 = drv;
                found_d_ps4 = 1;
            }
        }
    }
    assert(found_d_ps5 && found_d_ps4);
    assert(strstr(d_ps5.path, "/ps5_games") != NULL);
    assert(strstr(d_ps4.path, "/ps4_games") != NULL);
    assert(strcmp(d_ps5.path, d_ps4.path) != 0);
    assert(d_ps5.pkg_count == 2);
    assert(d_ps4.pkg_count == 3);

    /* Verify smb_client_find_share_cfg correctly maps URLs by subpath */
    char test_url1[512], test_url2[512];
    snprintf(test_url1, sizeof(test_url1), "%s/0001.pkg", d_ps5.path);
    snprintf(test_url2, sizeof(test_url2), "%s/0001.pkg", d_ps4.path);
    smb_share_config_t cfg_found;
    assert(smb_client_find_share_cfg(test_url1, &cfg_found) == 0);
    assert(strcmp(cfg_found.id, "smb_ps5") == 0);
    assert(smb_client_find_share_cfg(test_url2, &cfg_found) == 0);
    assert(strcmp(cfg_found.id, "smb_ps4") == 0);

    /* Quick scan one share: must NOT overwrite or wipe the other share */
    changed = -1;
    assert(pkg_scanner_scan_quick("smb_ps4", &changed) == 5);
    assert(changed == 0);
    for (size_t d = 0; d < pkg_scanner_get_drive_count(); d++) {
        pkg_drive_t drv;
        if (pkg_scanner_get_drive_at(d, &drv) == 0) {
            if (strcmp(drv.id, "smb_ps5") == 0) assert(drv.pkg_count == 2);
            if (strcmp(drv.id, "smb_ps4") == 0) assert(drv.pkg_count == 3);
        }
    }

    /* Add new package to ps4_games and quick scan ps4: ps5 count must remain intact */
    char p6[512];
    snprintf(p6, sizeof(p6), "%s/0004.pkg", ps4_dir);
    assert(fixture_write_ps4_pkg(p6, "CUSA92004", "PS4 Game 4", "gd", "01.00") == 0);
    changed = -1;
    assert(pkg_scanner_scan_quick("smb_ps4", &changed) == 6);
    assert(changed == 1);
    for (size_t d = 0; d < pkg_scanner_get_drive_count(); d++) {
        pkg_drive_t drv;
        if (pkg_scanner_get_drive_at(d, &drv) == 0) {
            if (strcmp(drv.id, "smb_ps5") == 0) assert(drv.pkg_count == 2);
            if (strcmp(drv.id, "smb_ps4") == 0) assert(drv.pkg_count == 4);
        }
    }

    /* Cleanup multi-root */
    unlink(p1); unlink(p2); unlink(p3); unlink(p4); unlink(p5); unlink(p6);
    rmdir(ps5_dir); rmdir(ps4_dir); rmdir(smb_multi_root);
    puts("Multiple Samba locations distinct path and isolation test passed");

    pkg_cache_clear();
    char file[512];
    snprintf(file, sizeof(file), "%s/settings.json", cache);
    unlink(file);
    rmdir(cache);
    puts("SMB large-share regressions passed");
    return 0;
}
