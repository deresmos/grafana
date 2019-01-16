// Libaries
import angular from 'angular';
import _ from 'lodash';

// Components
import './editor_ctrl';
import coreModule from 'app/core/core_module';

// Utils & Services
import { makeRegions, dedupAnnotations } from './events_processing';

// Types
import { DashboardModel } from '../dashboard/dashboard_model';

export class AnnotationsSrv {
  globalAnnotationsPromise: any;
  alertStatesPromise: any;
  datasourcePromises: any;
  builtInDatasource: string;

  defaultDatasource = '-- Grafana --';

  /** @ngInject */
  constructor(private $rootScope, private $q, private datasourceSrv, private backendSrv, private timeSrv) {}

  init(dashboard: DashboardModel) {
    // clear promises on refresh events
    dashboard.on('refresh', () => {
      this.globalAnnotationsPromise = null;
      this.alertStatesPromise = null;
      this.datasourcePromises = null;
    });
  }

  getAnnotations(options) {
    return this.$q
      .all([this.getGlobalAnnotations(options), this.getAlertStates(options)])
      .then(results => {
        // combine the annotations and flatten results
        let annotations = _.flattenDeep(results[0]);

        // filter out annotations that do not belong to requesting panel
        annotations = _.filter(annotations, item => {
          // if event has panel id and query is of type dashboard then panel and requesting panel id must match
          if (item.panelId && item.source.type === 'dashboard') {
            return item.panelId === options.panel.id;
          }
          return true;
        });

        annotations = dedupAnnotations(annotations);
        annotations = makeRegions(annotations, options);

        // look for alert state for this panel
        const alertState = _.find(results[1], { panelId: options.panel.id });

        return {
          annotations: annotations,
          alertState: alertState,
        };
      })
      .catch(err => {
        if (!err.message && err.data && err.data.message) {
          err.message = err.data.message;
        }
        console.log('AnnotationSrv.query error', err);
        this.$rootScope.appEvent('alert-error', ['Annotation Query Failed', err.message || err]);
        return [];
      });
  }

  getAlertStates(options) {
    if (!options.dashboard.id) {
      return this.$q.when([]);
    }

    // ignore if no alerts
    if (options.panel && !options.panel.alert) {
      return this.$q.when([]);
    }

    if (options.range.raw.to !== 'now') {
      return this.$q.when([]);
    }

    if (this.alertStatesPromise) {
      return this.alertStatesPromise;
    }

    this.alertStatesPromise = this.backendSrv.get('/api/alerts/states-for-dashboard', {
      dashboardId: options.dashboard.id,
    });
    return this.alertStatesPromise;
  }

  getGlobalAnnotations(options) {
    const dashboard = options.dashboard;

    this.builtInDatasource = _.filter(this.timeSrv.dashboard.annotations.list, (v: any) => v.builtIn)[0].datasource;

    if (this.globalAnnotationsPromise) {
      return this.globalAnnotationsPromise;
    }

    const range = this.timeSrv.timeRange();
    const promises = [];
    const dsPromises = [];

    for (const annotation of dashboard.annotations.list) {
      if (!annotation.enable) {
        continue;
      }

      if (annotation.snapshotData) {
        return this.translateQueryResult(annotation, annotation.snapshotData);
      }
      const datasourcePromise = this.datasourceSrv.get(annotation.datasource);
      dsPromises.push(datasourcePromise);
      promises.push(
        datasourcePromise
          .then(datasource => {
            // issue query against data source
            return datasource.annotationQuery({
              range: range,
              rangeRaw: range.raw,
              annotation: annotation,
              dashboard: dashboard,
            });
          })
          .then(results => {
            // store response in annotation object if this is a snapshot call
            if (dashboard.snapshot) {
              annotation.snapshotData = angular.copy(results);
            }
            // translate result
            return this.translateQueryResult(annotation, results);
          })
      );
    }
    this.datasourcePromises = this.$q.all(dsPromises);
    this.globalAnnotationsPromise = this.$q.all(promises);
    return this.globalAnnotationsPromise;
  }

  _checkPermission(annotation: any) {
    const user: any = this.backendSrv.contextSrv.user;
    if (annotation.userId !== user.id && !user.isGrafanaAdmin) {
      this.$rootScope.appEvent('alert-warning', [
        'Edit permission denied',
      ]);
      return false;
    }

    return true;
  }

  _promiseWriteInfluxDB(annotation: any, create = true) {
    return this.datasourceSrv.get(this.builtInDatasource).then( (ds) => {
      const id = (create === true ? new Date().getTime() : annotation.id);

      let payload = 'events,id=' + id + ' ';
      if (create) {
        const user: any = this.backendSrv.contextSrv.user;
        payload += 'userId=' + user.id + ',';
        payload += 'login="' + user.login + '",';
        payload += 'avatarUrl="' + user.gravatarUrl + '",';
        payload += 'email="' + user.email + '",';
      } else {
        if (!this._checkPermission(annotation)) {
          return;
        }
      }

      payload += 'panelId=' + annotation.panelId + ',';
      payload += 'dashboardId=' + annotation.dashboardId + ',';
      // payload += 'isRegion=' + annotation.isRegion + ',';
      payload += 'tags="' + annotation.tags.join(',') + '",';
      payload += 'text="' + annotation.text + '" ';

      payload += ' ' + annotation.time + '000000';

      return this.backendSrv.$http({
        url: ds.urls[0] + '/write?db=' + ds.database,
        method: 'POST',
        data: payload,
      }).then((rsp) => {
        this.$rootScope.appEvent('alert-success', [
          'Update annotation to InfluxDB',
        ]);
      }, err => {
        this.$rootScope.appEvent('alert-warning', [
          'Failed write annotation to InfluxDB',
        ]);
        console.log(err);
      });
    });
  }

  saveAnnotationEvent(annotation) {
    this.globalAnnotationsPromise = null;

    if (this.builtInDatasource === this.defaultDatasource) {
      return this.backendSrv.post('/api/annotations', annotation);

    } else {
      return this._promiseWriteInfluxDB(annotation, true);
    }
  }

  updateAnnotationEvent(annotation) {
    this.globalAnnotationsPromise = null;

    const datasource = annotation.source.datasource;
    if (datasource === this.defaultDatasource) {
      return this.backendSrv.put(`/api/annotations/${annotation.id}`, annotation);

    } else {
      return this._promiseWriteInfluxDB(annotation, false);
    }
  }

  deleteAnnotationEvent(annotation) {
    this.globalAnnotationsPromise = null;

    const datasource = annotation.source.datasource;
    if (datasource === this.defaultDatasource) {
      // -- Grafana --
      let deleteUrl = `/api/annotations/${annotation.id}`;
      if (annotation.isRegion) {
        deleteUrl = `/api/annotations/region/${annotation.regionId}`;
      }

      return this.backendSrv.delete(deleteUrl);

    } else {
      return this.datasourceSrv.get(datasource).then( (ds) => {
        // InfluxDB
        if (!this._checkPermission(annotation)) {
          return;
        }

        const payload: any = {
          'db': ds.database,
          'q': 'DELETE FROM events WHERE "id" = \'' + annotation.id + '\'',
        };

        return this.backendSrv.$http({
          url: ds.urls[0] + '/query',
          method: 'POST',
          params: payload,
        }).then((rsp) => {
          this.$rootScope.appEvent('alert-success', [
            'Deleted annotation to InfluxDB',
          ]);
        }, err => {
          this.$rootScope.appEvent('alert-warning', [
            'Failed delete annotation to InfluxDB',
          ]);
          console.log(err);
        });
      });
    }
  }

  translateQueryResult(annotation, results) {
    // if annotation has snapshotData
    // make clone and remove it
    if (annotation.snapshotData) {
      annotation = angular.copy(annotation);
      delete annotation.snapshotData;
    }

    for (const item of results) {
      item.source = annotation;
    }
    return results;
  }
}

coreModule.service('annotationsSrv', AnnotationsSrv);
