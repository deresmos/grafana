// Libaries
import angular, { IQService } from 'angular';
import _ from 'lodash';

// Components
import './editor_ctrl';
import coreModule from 'app/core/core_module';
import AnnotationInflux from './annotation_influxdb';

// Utils & Services
import { dedupAnnotations } from './events_processing';

// Types
import { DashboardModel } from '../dashboard/state/DashboardModel';
import { AnnotationEvent } from '@grafana/data';
import DatasourceSrv from '../plugins/datasource_srv';
import { BackendSrv } from 'app/core/services/backend_srv';
import { TimeSrv } from '../dashboard/services/TimeSrv';
import { DataSourceApi } from '@grafana/ui';
import { ContextSrv } from 'app/core/services/context_srv';

export class AnnotationsSrv extends AnnotationInflux {
  globalAnnotationsPromise: any;
  alertStatesPromise: any;
  datasourcePromises: any;

  /** @ngInject */
  constructor(
    $rootScope: any,
    private $q: IQService,
    datasourceSrv: DatasourceSrv,
    backendSrv: BackendSrv,
    private timeSrv: TimeSrv,
    $http: any,
    contextSrv: ContextSrv
  ) {
    super($rootScope, datasourceSrv, backendSrv, $http, contextSrv);
  }

  init(dashboard: DashboardModel) {
    // always clearPromiseCaches when loading new dashboard
    this.clearPromiseCaches();
    // clear promises on refresh events
    dashboard.on('refresh', this.clearPromiseCaches.bind(this));
  }

  clearPromiseCaches() {
    this.globalAnnotationsPromise = null;
    this.alertStatesPromise = null;
    this.datasourcePromises = null;
    this.builtInDatasource = this.timeSrv.dashboard.annotations.list[0].datasource;
  }

  getAnnotations(options: any) {
    return this.$q
      .all([this.getGlobalAnnotations(options), this.getAlertStates(options)])
      .then(results => {
        // combine the annotations and flatten results
        let annotations: AnnotationEvent[] = _.flattenDeep(results[0]);

        // filter out annotations that do not belong to requesting panel
        annotations = _.filter(annotations, item => {
          // if event has panel id and query is of type dashboard then panel and requesting panel id must match
          if (item.panelId && item.source.type === 'dashboard') {
            return item.panelId === options.panel.id;
          }
          return true;
        });

        annotations = dedupAnnotations(annotations);

        // look for alert state for this panel
        const alertState: any = _.find(results[1], { panelId: options.panel.id });

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

  getAlertStates(options: any) {
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

  getGlobalAnnotations(options: any) {
    const dashboard = options.dashboard;

    this.builtInDatasource = this.timeSrv.dashboard.annotations.list[0].datasource;

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
          .then((datasource: DataSourceApi) => {
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

  saveAnnotationEvent(annotation: AnnotationEvent) {
    this.globalAnnotationsPromise = null;

    if (this.builtInDatasource === '-- Grafana --') {
      return this.backendSrv.post('/api/annotations', annotation);
    } else {
      // InfluxDB
      return this.insertInfluxDB(annotation);
    }
  }

  updateAnnotationEvent(annotation: AnnotationEvent) {
    this.globalAnnotationsPromise = null;

    const datasource = annotation.source.datasource;
    if (datasource === '-- Grafana --') {
      return this.backendSrv.put(`/api/annotations/${annotation.id}`, annotation);
    } else {
      // InfluxDB
      return this.updateInfluxDB(annotation);
    }
  }

  deleteAnnotationEvent(annotation: AnnotationEvent) {
    this.globalAnnotationsPromise = null;
    const datasource = annotation.source.datasource;
    if (datasource === '-- Grafana --') {
      const deleteUrl = `/api/annotations/${annotation.id}`;

      return this.backendSrv.delete(deleteUrl);
    } else {
      return this.deleteInfluxDB(annotation);
    }
  }

  translateQueryResult(annotation: any, results: any) {
    // if annotation has snapshotData
    // make clone and remove it
    if (annotation.snapshotData) {
      annotation = angular.copy(annotation);
      delete annotation.snapshotData;
    }

    for (const item of results) {
      item.source = annotation;
      item.isRegion = item.timeEnd && item.time !== item.timeEnd;
    }

    return results;
  }
}

coreModule.service('annotationsSrv', AnnotationsSrv);
